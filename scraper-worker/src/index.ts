import puppeteer from '@cloudflare/puppeteer';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { intelBriefings } from './db/schema';

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
		// Yunnan Daily — pattern: /html/YYYY/MMDD/YYYYMMDD_001/YYYYMMDD_001_<id>.html
		// We land on the index page and discover article links from there
		`https://yndaily.yunnan.cn/html/${yyyy}/${mm}${dd}/${yyyymmdd}_001/${yyyymmdd}_001_6618.html#0`,

		// Sichuan Daily
		`https://4g.scdaily.cn/wap/scrb/${yyyymmdd}/index.html`,

		// Guangxi Daily (static URL — date is selected server-side)
		`https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001`,

		// Hunan Daily (static URL — SPA loads today's edition)
		`https://h5cgi.voc.com.cn/hnrbdzb/#/`,

		// Fujian Daily
		`https://fjrb.fjdaily.com/pad/col/${yyyy}${mm}/${dd}/node_01.html`,

		// Nanfang Daily
		`https://epaper.nfnews.com/m/ipaper/nfrb/html/${yyyy}${mm}/${dd}/node_A05.html#/`,

		// Hainan Daily
		`https://news.hndaily.cn/h5/html5/${yyyy}-${mm}/${dd}/node_58471.htm`,
	];
}

// ---------- puppeteer helpers ----------

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

async function scrapeUrl(browser: Browser, startUrl: string): Promise<string> {
	const page = await browser.newPage();

	// Block images, stylesheets, and fonts to speed up scraping
	await page.setRequestInterception(true);
	page.on('request', (req) => {
		const type = req.resourceType();
		if (type === 'image' || type === 'stylesheet' || type === 'font') {
			req.abort();
		} else {
			req.continue();
		}
	});

	const chunks: string[] = [];

	try {
		await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

		// Step 1 — collect sub-page / article links on the index page
		const subLinks = await page.evaluate((base: string) => {
			const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
			const seen = new Set<string>();
			const links: string[] = [];
			for (const a of anchors) {
				const href = a.href;
				if (!href || href === base || href.startsWith('javascript') || href.startsWith('#')) continue;
				// Only follow same-origin links that look like article/node pages
				try {
					const url = new URL(href);
					const baseUrl = new URL(base);
					if (url.hostname !== baseUrl.hostname) continue;
					if (seen.has(href)) continue;
					// Heuristic: links with "node", "article", "content", page numbers, or .html
					if (
						/node|article|content|page|\d{4,}|\.html|\.htm/.test(url.pathname + url.hash)
					) {
						seen.add(href);
						links.push(href);
					}
				} catch {
					// ignore malformed
				}
			}
			return links.slice(0, 25); // cap at 25 sub-pages per source
		}, startUrl);

		// Step 2 — scrape the index page itself first
		const indexText = await page.evaluate(() => document.body.innerText);
		if (indexText.trim()) chunks.push(`[INDEX] ${startUrl}\n${indexText.trim()}`);

		// Step 3 — scrape each sub-page
		for (const link of subLinks) {
			const subPage = await browser.newPage();
			await subPage.setRequestInterception(true);
			subPage.on('request', (req) => {
				const type = req.resourceType();
				if (type === 'image' || type === 'stylesheet' || type === 'font') {
					req.abort();
				} else {
					req.continue();
				}
			});
			try {
				await subPage.goto(link, { waitUntil: 'networkidle2', timeout: 20_000 });
				const text = await subPage.evaluate(() => document.body.innerText);
				if (text.trim().length > 100) {
					chunks.push(`[PAGE] ${link}\n${text.trim()}`);
				}
			} catch {
				// non-fatal — skip this sub-page
			} finally {
				await subPage.close();
			}
		}
	} catch (err) {
		chunks.push(`[ERROR scraping ${startUrl}]: ${String(err)}`);
	} finally {
		await page.close();
	}

	return chunks.join('\n\n---\n\n');
}

// ---------- AI analysis ----------

const SYSTEM_PROMPT = `You are an expert analyst of Chinese provincial print media.
You have been given raw text scraped from today's editions of multiple Chinese provincial newspapers.
Your task is to produce a structured intelligence briefing in English Markdown.

Organise findings into these categories. For each article mention: page reference (if visible), original Chinese title, English translation, and a brief geopolitical inference where relevant.

## Categories
1. Internal Political
2. External Political / Foreign Affairs
3. National Leader Movements (Politburo Standing Committee members)
4. Provincial Leader Movements
5. Economic / Commercial
6. Science & Technology
7. Social / Culture / Society
8. Common Syndicated News (Xinhua wire stories repeated across papers — list once)

## Format rules
- Use ### for each category heading.
- Use bullet points for each article.
- Flag items of high geopolitical significance with 🔴.
- At the top, add a one-paragraph **Executive Summary**.
- At the bottom, add a **Source Notes** section listing which newspaper URLs were scraped.`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyseWithWorkersAI(ai: any, rawText: string): Promise<string> {
	const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: `Raw scraped text follows:\n\n${rawText.slice(0, 100_000)}` },
		],
	});
	// Workers AI returns { response: string } for chat models
	if (response && typeof response.response === 'string') return response.response;
	throw new Error(`Unexpected Workers AI response shape: ${JSON.stringify(response)}`);
}

// ---------- email ----------

async function sendEmail(
	resendApiKey: string,
	from: string,
	to: string,
	date: string,
	markdown: string,
): Promise<void> {
	const htmlBody = `<pre style="font-family:monospace;white-space:pre-wrap">${markdown.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${resendApiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from,
			to: [to],
			subject: `China Intel Briefing — ${date}`,
			html: htmlBody,
		}),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Resend error ${res.status}: ${body}`);
	}
}

// ---------- shared pipeline ----------

async function runPipeline(env: Env): Promise<string> {
	const { yyyy, mm, dd } = getCSTDateParts();
	const trackingDate = `${yyyy}-${mm}-${dd}`;
	const db = drizzle(env.DB);

	// Idempotency check — skip if we already ran today
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
	// Restore the block below once the daily quota resets.
	// const urls = buildUrls(yyyy, mm, dd);
	// const browser = await puppeteer.launch(env.BROWSER);
	// const scrapedParts: string[] = [];
	// for (const url of urls) { ... }
	// await browser.close();
	// const rawScrapedText = scrapedParts.join('\n\n==========\n\n');

	const rawScrapedText = "中国国家航天局宣布，嫦娥六号探测器成功在月球背面软着陆，这是人类历史上首次在月球背面进行采样返回任务。此外，经济部门报告称，第一季度国内生产总值同比增长5.3%。";
	console.log('[MOCK MODE] Using hardcoded Chinese text — Puppeteer bypassed.');

	console.log('Sending to Workers AI for analysis…');
	const aiAnalysisMarkdown = await analyseWithWorkersAI(env.AI, rawScrapedText);

	// Upsert into D1
	await db
		.insert(intelBriefings)
		.values({ trackingDate, rawScrapedText, aiAnalysisMarkdown, emailStatus: 0 })
		.onConflictDoUpdate({
			target: intelBriefings.trackingDate,
			set: { rawScrapedText, aiAnalysisMarkdown, emailStatus: 0 },
		});

	console.log('Saved to D1.');

	if (env.ENABLE_EMAIL === 'true') {
		console.log('Email dispatch enabled — sending via Resend…');
		try {
			await sendEmail(
				env.RESEND_API_KEY,
				env.RESEND_FROM_EMAIL,
				env.RESEND_TO_EMAIL,
				trackingDate,
				aiAnalysisMarkdown,
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
		console.log('Email dispatch is currently disabled via ENABLE_EMAIL flag.');
	}

	return `Scraper pipeline completed for ${trackingDate}.`;
}

// ---------- handlers ----------

export default {
	async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		console.log('Manual HTTP trigger received. Starting scraper execution…');
		try {
			const result = await runPipeline(env);
			return new Response(result, { status: 200, headers: { 'Content-Type': 'text/plain' } });
		} catch (err) {
			console.error('Pipeline error:', err);
			return new Response(`Scraper error: ${String(err)}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('Automated cron trigger fired. Starting scraper execution…');
		await runPipeline(env);
	},
};
