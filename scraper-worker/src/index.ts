import puppeteer from '@cloudflare/puppeteer';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { intelBriefings, intelArticles } from './db/schema';

export interface Env {
	DB: D1Database;
	BROWSER: Fetcher;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AI: any;
	// Email — set ENABLE_EMAIL="true" as a Worker secret to activate dispatch.
	// Default is "false" (set in wrangler.jsonc vars) so no Resend keys are required.
	ENABLE_EMAIL: string;
	RESEND_API_KEY: string;
	RESEND_TO_EMAIL: string;
	RESEND_FROM_EMAIL: string;
}

// ---------- date helpers ----------

function getCSTDateParts(): { yyyy: string; mm: string; dd: string } {
	// UTC+8
	const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
	const yyyy = now.getUTCFullYear().toString();
	const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(now.getUTCDate()).padStart(2, '0');
	return { yyyy, mm, dd };
}

interface Source {
	name: string;
	url: string;
}

function buildSources(yyyy: string, mm: string, dd: string): Source[] {
	const yyyymmdd = `${yyyy}${mm}${dd}`;
	return [
		{ name: 'Yunnan Daily',  url: `https://yndaily.yunnan.cn/html/${yyyy}/${mm}${dd}/${yyyymmdd}_001/${yyyymmdd}_001_6618.html#0` },
		{ name: 'Sichuan Daily', url: `https://4g.scdaily.cn/wap/scrb/${yyyymmdd}/index.html` },
		{ name: 'Guangxi Daily', url: `https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001` },
		{ name: 'Hunan Daily',   url: `https://h5cgi.voc.com.cn/hnrbdzb/#/` },
		{ name: 'Fujian Daily',  url: `https://fjrb.fjdaily.com/pad/col/${yyyy}${mm}/${dd}/node_01.html` },
		{ name: 'Nanfang Daily', url: `https://epaper.nfnews.com/m/ipaper/nfrb/html/${yyyy}${mm}/${dd}/node_A05.html#/` },
		{ name: 'Hainan Daily',  url: `https://news.hndaily.cn/h5/html5/${yyyy}-${mm}/${dd}/node_58471.htm` },
	];
}

// ---------- puppeteer helpers ----------

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

interface ScrapedArticle {
	title: string;
	full_text: string;
	url: string;
	source: string;
}

async function scrapeUrl(browser: Browser, startUrl: string, sourceName: string): Promise<ScrapedArticle[]> {
	const page = await browser.newPage();

	await page.setRequestInterception(true);
	page.on('request', (req) => {
		const type = req.resourceType();
		if (type === 'image' || type === 'stylesheet' || type === 'font') req.abort();
		else req.continue();
	});

	const articles: ScrapedArticle[] = [];

	try {
		await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

		const subLinks = await page.evaluate((base: string) => {
			const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
			const seen = new Set<string>();
			const links: string[] = [];
			for (const a of anchors) {
				const href = a.href;
				if (!href || href === base || href.startsWith('javascript') || href.startsWith('#')) continue;
				try {
					const url = new URL(href);
					const baseUrl = new URL(base);
					if (url.hostname !== baseUrl.hostname) continue;
					if (seen.has(href)) continue;
					if (/node|article|content|page|\d{4,}|\.html|\.htm/.test(url.pathname + url.hash)) {
						seen.add(href);
						links.push(href);
					}
				} catch { /* ignore malformed */ }
			}
			return links.slice(0, 25);
		}, startUrl);

		// Index page as an article
		const indexText = await page.evaluate(() => document.body.innerText);
		const indexTitle = await page.evaluate(() => document.title);
		if (indexText.trim()) {
			articles.push({ title: indexTitle || startUrl, full_text: indexText.trim(), url: startUrl, source: sourceName });
		}

		// Sub-pages as individual articles
		for (const link of subLinks) {
			const subPage = await browser.newPage();
			await subPage.setRequestInterception(true);
			subPage.on('request', (req) => {
				const type = req.resourceType();
				if (type === 'image' || type === 'stylesheet' || type === 'font') req.abort();
				else req.continue();
			});
			try {
				await subPage.goto(link, { waitUntil: 'networkidle2', timeout: 20_000 });
				const text = await subPage.evaluate(() => document.body.innerText);
				const title = await subPage.evaluate(() => document.title);
				if (text.trim().length > 100) {
					articles.push({ title: title || link, full_text: text.trim(), url: link, source: sourceName });
				}
			} catch { /* non-fatal */ } finally {
				await subPage.close();
			}
		}
	} catch (err) {
		console.error(`[ERROR scraping ${startUrl}]:`, err);
	} finally {
		await page.close();
	}

	return articles;
}

// ---------- AI analysis ----------

const SYSTEM_PROMPT = `You are an intelligence analyst processing Chinese provincial newspaper articles.
You will receive a JSON array of article objects, each with "title" (Chinese), "full_text" (Chinese), and "url".

Return ONLY a valid JSON array — no markdown, no code fences, no explanation. Each element must have:
- "title": English translation of the original Chinese title (concise, accurate)
- "summary": 2–3 sentence geopolitical analysis in English (flag high-significance items with [HIGH])
- "full_text_en": complete, faithful English translation of the full_text field
- "url": copy the original URL unchanged
- "category": classify into exactly one of: "Political", "Military", "Economic", "Technology", "Social", "Foreign Affairs"

Your output must be parseable by JSON.parse() with no preprocessing.`;

interface AiArticle {
	title: string;
	summary: string;
	full_text_en: string;
	url: string;
	category: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyseWithWorkersAI(ai: any, articles: ScrapedArticle[]): Promise<AiArticle[]> {
	const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				content: JSON.stringify(
					articles.map((a) => ({
						title: a.title,
						full_text: a.full_text.slice(0, 2_000), // cap per-article to stay within context
						url: a.url,
					})),
				).slice(0, 100_000),
			},
		],
	});

	if (!response || typeof response.response !== 'string') {
		throw new Error(`Unexpected Workers AI response shape: ${JSON.stringify(response)}`);
	}

	// Extract all [...] JSON arrays from the response and try each from last to first.
	// The model sometimes echoes the input array before its output, so we prefer the last match.
	const allMatches = [...response.response.matchAll(/\[[\s\S]*?\]/g)];
	// Also try a greedy match for the largest array span
	const greedyMatch = response.response.match(/\[[\s\S]*\]/);
	const candidates = greedyMatch ? [greedyMatch[0], ...allMatches.map(m => m[0])] : allMatches.map(m => m[0]);

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].title) {
				console.log('[AI PARSED]', parsed.length, 'articles, first title:', parsed[0].title);
				return parsed as AiArticle[];
			}
		} catch { /* try next */ }
	}

	// Hard fallback: one article per scraped item with raw title, no summary
	console.log('[AI FALLBACK] Could not parse JSON array from response');
	return articles.map((a) => ({ title: a.title, summary: 'Analysis unavailable.', full_text_en: '', url: a.url, category: 'Uncategorized' }));
}

// ---------- email ----------

async function sendEmail(
	resendApiKey: string,
	from: string,
	to: string,
	date: string,
	articles: AiArticle[],
): Promise<void> {
	const body = articles
		.map((a) => `<h3>${a.title}</h3><p>${a.summary}</p><a href="${a.url}">${a.url}</a>`)
		.join('<hr/>');
	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			from,
			to: [to],
			subject: `China Intel Briefing — ${date}`,
			html: `<html><body>${body}</body></html>`,
		}),
	});
	if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

// ---------- shared pipeline ----------

async function runPipeline(env: Env): Promise<string> {
	const { yyyy, mm, dd } = getCSTDateParts();
	const trackingDate = `${yyyy}-${mm}-${dd}`;
	const db = drizzle(env.DB);

	// Idempotency check
	const existing = await db
		.select()
		.from(intelBriefings)
		.where(eq(intelBriefings.trackingDate, trackingDate))
		.limit(1);

	if (existing.length > 0 && existing[0].aiAnalysisMarkdown) {
		const msg = `Already processed ${trackingDate}, skipping.`;
		console.log(msg);
		return msg;
	}

	const sources = buildSources(yyyy, mm, dd);
	const browser = await puppeteer.launch(env.BROWSER);
	const scrapedArticles: ScrapedArticle[] = [];
	for (const { url, name } of sources) {
		const arts = await scrapeUrl(browser, url, name);
		scrapedArticles.push(...arts);
	}
	await browser.close();

	if (scrapedArticles.length === 0) {
		const msg = `No articles scraped for ${trackingDate} — all sources may be unavailable.`;
		console.warn(msg);
		return msg;
	}

	console.log(`Scraped ${scrapedArticles.length} articles. Sending to Workers AI for analysis…`);

	const aiArticles = await analyseWithWorkersAI(env.AI, scrapedArticles);

	// Build a combined raw text for the briefing record
	const rawScrapedText = scrapedArticles
		.map((a) => `[${a.url}]\n${a.title}\n${a.full_text}`)
		.join('\n\n---\n\n');

	// Upsert the daily briefing parent record
	// aiAnalysisMarkdown stores "done" sentinel so idempotency check fires on re-run
	await db
		.insert(intelBriefings)
		.values({ trackingDate, rawScrapedText, aiAnalysisMarkdown: 'articles', emailStatus: 0 })
		.onConflictDoUpdate({
			target: intelBriefings.trackingDate,
			set: { rawScrapedText, aiAnalysisMarkdown: 'articles', emailStatus: 0 },
		});

	// Insert individual articles
	for (let i = 0; i < aiArticles.length; i++) {
		const ai = aiArticles[i];
		const scraped = scrapedArticles[i];
		await db.insert(intelArticles).values({
			trackingDate,
			title: ai.title ?? scraped?.title,
			summary: ai.summary,
			fullText: scraped?.full_text,
			fullTextEn: ai.full_text_en,
			url: ai.url || scraped?.url,
			category: ai.category ?? null,
			source: scraped?.source ?? null,
			isPreserved: 0,
		});
	}

	console.log(`Saved ${aiArticles.length} articles to D1.`);

	// 30-day cleanup of unpreserved articles
	await env.DB.prepare(
		`DELETE FROM intel_articles WHERE created_at <= datetime('now', '-30 days') AND is_preserved = 0`,
	).run();

	if (env.ENABLE_EMAIL === 'true') {
		console.log('Email dispatch enabled — sending via Resend…');
		try {
			await sendEmail(
				env.RESEND_API_KEY,
				env.RESEND_FROM_EMAIL,
				env.RESEND_TO_EMAIL,
				trackingDate,
				aiArticles,
			);
			await db
				.update(intelBriefings)
				.set({ emailStatus: 1 })
				.where(eq(intelBriefings.trackingDate, trackingDate));
			console.log('Email sent successfully.');
		} catch (err) {
			console.error('Email send failed (briefing saved):', err);
		}
	} else {
		console.log('Email dispatch disabled via ENABLE_EMAIL flag.');
	}

	return `Pipeline completed for ${trackingDate} — ${aiArticles.length} articles.`;
}

// ---------- handlers ----------

export default {
	async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		console.log('Manual Shadcn Light Mode Email Test Triggered.');

		const db = drizzle(env.DB);
		const recentArticles = await db.select().from(intelArticles).limit(10);

		if (!recentArticles || recentArticles.length === 0) {
			return new Response('No articles found in DB to send.', { status: 404 });
		}

		const today = new Date().toISOString().split('T')[0];

		const htmlContent = `
<div style="font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 650px; margin: 0 auto; background-color: #f8fafc; padding: 24px; color: #0f172a;">

  <div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px;">
    <p style="color: #ef4444; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 8px 0;">
      Intelligence Briefing
    </p>
    <h1 style="color: #0f172a; font-size: 36px; font-weight: 700; margin: 0; letter-spacing: -0.025em;">
      ${today}
    </h1>
    <p style="color: #64748b; font-size: 14px; margin-top: 8px; margin-bottom: 0;">
      Chinese Provincial Press Monitor &bull; ${recentArticles.length} Articles &bull; CST Morning Edition
    </p>
  </div>

  ${recentArticles.map((a) => `
    <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);">
      <h2 style="color: #0f172a; font-size: 18px; font-weight: 600; margin: 0 0 12px 0; line-height: 1.4;">
        ${a.title ?? '(no title)'}
      </h2>
      <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
        ${a.summary ?? ''}
      </p>
      <div style="border-top: 1px solid #f1f5f9; padding-top: 16px;">
        <a href="${a.url ?? '#'}" target="_blank" style="color: #ef4444; font-size: 14px; font-weight: 500; text-decoration: none;">
          View Source URL →
        </a>
      </div>
    </div>
  `).join('')}

  <div style="margin-top: 32px; text-align: center; color: #94a3b8; font-size: 12px;">
    <p>This is an automated intelligence brief generated via Cloudflare Workers AI.</p>
  </div>
</div>`;

		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				from: env.RESEND_FROM_EMAIL,
				to: [env.RESEND_TO_EMAIL],
				subject: `Intel Briefing: ${today}`,
				html: htmlContent,
			}),
		});

		if (res.ok) {
			return new Response('Light mode test email dispatched! Check your inbox.', { status: 200 });
		} else {
			const errorText = await res.text();
			return new Response(`Resend API Error: ${errorText}`, { status: 500 });
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('Cron trigger fired. Starting pipeline…');
		await runPipeline(env);
	},
};
