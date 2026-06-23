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

function buildUrls(yyyy: string, mm: string, dd: string): string[] {
	const yyyymmdd = `${yyyy}${mm}${dd}`;
	return [
		`https://yndaily.yunnan.cn/html/${yyyy}/${mm}${dd}/${yyyymmdd}_001/${yyyymmdd}_001_6618.html#0`,
		`https://4g.scdaily.cn/wap/scrb/${yyyymmdd}/index.html`,
		`https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001`,
		`https://h5cgi.voc.com.cn/hnrbdzb/#/`,
		`https://fjrb.fjdaily.com/pad/col/${yyyy}${mm}/${dd}/node_01.html`,
		`https://epaper.nfnews.com/m/ipaper/nfrb/html/${yyyy}${mm}/${dd}/node_A05.html#/`,
		`https://news.hndaily.cn/h5/html5/${yyyy}-${mm}/${dd}/node_58471.htm`,
	];
}

// ---------- puppeteer helpers ----------

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

interface ScrapedArticle {
	title: string;
	full_text: string;
	url: string;
}

async function scrapeUrl(browser: Browser, startUrl: string): Promise<ScrapedArticle[]> {
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
			articles.push({ title: indexTitle || startUrl, full_text: indexText.trim(), url: startUrl });
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
					articles.push({ title: title || link, full_text: text.trim(), url: link });
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

Your output must be parseable by JSON.parse() with no preprocessing.`;

interface AiArticle {
	title: string;
	summary: string;
	full_text_en: string;
	url: string;
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
	return articles.map((a) => ({ title: a.title, summary: 'Analysis unavailable.', url: a.url }));
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

	// TEMPORARILY BYPASSING PUPPETEER — Browser Rendering free tier 429 limit reached.
	// To restore live scraping, uncomment the block below and remove the mock assignment.
	//
	// const urls = buildUrls(yyyy, mm, dd);
	// const browser = await puppeteer.launch(env.BROWSER);
	// const scrapedArticles: ScrapedArticle[] = [];
	// for (const url of urls) {
	//   const arts = await scrapeUrl(browser, url);
	//   scrapedArticles.push(...arts);
	// }
	// await browser.close();

	const scrapedArticles: ScrapedArticle[] = [
		{
			title: '嫦娥六号探测器成功在月球背面软着陆',
			full_text: '中国国家航天局宣布，嫦娥六号探测器成功在月球背面软着陆，这是人类历史上首次在月球背面进行采样返回任务。科学家表示，此次任务将帮助人类更好地了解月球的地质历史。',
			url: 'https://example.com/mock/change6',
		},
		{
			title: '第一季度国内生产总值同比增长5.3%',
			full_text: '经济部门报告称，第一季度国内生产总值同比增长5.3%，超过市场预期。其中，高技术制造业和服务业增速较快，外贸出口也实现正增长。',
			url: 'https://example.com/mock/gdp',
		},
		{
			title: '全国人大常委会审议新能源法草案',
			full_text: '全国人民代表大会常务委员会本周开始审议新能源法草案，该法案旨在规范可再生能源开发利用，加快实现碳达峰碳中和目标。',
			url: 'https://example.com/mock/energy-law',
		},
	];

	console.log('[MOCK MODE] Using hardcoded articles — Puppeteer bypassed.');
	console.log('Sending to Workers AI for analysis…');

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
		console.log('Manual HTTP trigger received. Starting pipeline…');
		try {
			const result = await runPipeline(env);
			return new Response(result, { status: 200, headers: { 'Content-Type': 'text/plain' } });
		} catch (err) {
			console.error('Pipeline error:', err);
			return new Response(`Scraper error: ${String(err)}`, {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('Cron trigger fired. Starting pipeline…');
		await runPipeline(env);
	},
};
