import puppeteer from '@cloudflare/puppeteer';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { intelBriefings, intelArticles, intelClusters, tempArticles } from './db/schema';

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

// ---------- fetch engine ----------

const FETCH_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
	'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function fetchHtml(url: string, referer?: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			headers: { ...FETCH_HEADERS, ...(referer ? { Referer: referer } : {}) },
			redirect: 'follow',
		});
		if (!res.ok) { console.warn(`[FETCH] ${res.status} for ${url}`); return null; }
		return await res.text();
	} catch (err) {
		console.warn(`[FETCH] Error fetching ${url}:`, err);
		return null;
	}
}

// Extract clean text from HTML — only semantic content tags, no scripts/styles/nav/attrs
async function extractText(html: string): Promise<string> {
	const chunks: string[] = [];
	let skip = false;

	const res = new Response(html, { headers: { 'Content-Type': 'text/html' } });
	const transformed = new HTMLRewriter()
		// Block non-content regions entirely
		.on('script, style, nav, header, footer, aside, noscript', {
			element() { skip = true; },
		})
		.on('script, style, nav, header, footer, aside, noscript', {
			// re-enable after the block closes — handled via text guard below
			element(el) { el.onEndTag(() => { skip = false; }); },
		})
		// Only pull text from semantic content tags
		.on('h1, h2, h3, h4, p', {
			text(chunk) {
				const t = chunk.text.trim();
				if (!skip && t) chunks.push(t);
			},
		})
		.transform(res);

	await transformed.text();
	// Collapse whitespace and join paragraphs with newlines
	return chunks.map(c => c.replace(/\s+/g, ' ')).join('\n').trim();
}

// -- Guangxi Daily: has a proper epaper API
// Index:   https://ssw.gxrb.com.cn/json/interface/epaper/api.php?
// Article: https://ssw.gxrb.com.cn/json/interface/epaper/api.php?name=gxrb&date=YYYY-MM-DD&code=001&xuhao=1
async function scrapeGuangxi(yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const base = 'https://ssw.gxrb.com.cn';
	const date = `${yyyy}-${mm}-${dd}`;
	const indexUrl = `${base}/json/interface/epaper/api.php?`;
	const indexHtml = await fetchHtml(indexUrl, base + '/');
	if (!indexHtml) return [];

	// Extract all article links: href="?name=gxrb&date=...&code=001&xuhao=1" title="..."
	const linkRe = /href="\?name=gxrb&date=[^&]+&code=(\d+)&xuhao=(\d+)"\s+title="([^"]+)"/g;
	const seen = new Set<string>();
	const links: { code: string; xuhao: string; title: string }[] = [];
	for (const m of indexHtml.matchAll(linkRe)) {
		const key = `${m[1]}-${m[2]}`;
		// Skip editor credit lines and app links
		if (seen.has(key) || /责任编辑|客户端|版责|广西云/.test(m[3])) continue;
		seen.add(key);
		links.push({ code: m[1], xuhao: m[2], title: m[3] });
	}

	console.log(`[GUANGXI] Found ${links.length} article links`);

	const articles: ScrapedArticle[] = [];
	// Limit to 20 articles to stay within AI context budget
	for (const { code, xuhao, title } of links.slice(0, 20)) {
		const articleUrl = `${base}/json/interface/epaper/api.php?name=gxrb&date=${date}&code=${code}&xuhao=${xuhao}`;
		const html = await fetchHtml(articleUrl, indexUrl);
		if (!html) continue;
		const text = await extractText(html);
		if (text.length < 50) continue;
		articles.push({ title, full_text: text, url: articleUrl, source: 'Guangxi Daily' });
	}

	console.log(`[GUANGXI] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Hainan Daily: static HTML, article links embedded as JS var map_NODE = { l: [...] }
// Node page URL already contains today's node ID (built by buildSources)
async function scrapeHainan(nodeUrl: string): Promise<ScrapedArticle[]> {
	const base = 'https://news.hndaily.cn';
	const nodeHtml = await fetchHtml(nodeUrl, base + '/');
	if (!nodeHtml) return [];

	// Extract content filenames from: l:["content_58464_19645177.htm", ...]
	const contentFiles: string[] = [];
	for (const m of nodeHtml.matchAll(/l:\[([^\]]+)\]/g)) {
		const files = m[1].match(/"(content_[^"]+\.htm)"/g);
		if (files) contentFiles.push(...files.map(f => f.replace(/"/g, '')));
	}

	// Base path is same directory as the node page
	const basePath = nodeUrl.substring(0, nodeUrl.lastIndexOf('/') + 1);
	console.log(`[HAINAN] Found ${contentFiles.length} content files`);

	const articles: ScrapedArticle[] = [];
	for (const file of contentFiles.slice(0, 15)) {
		const articleUrl = basePath + file;
		const html = await fetchHtml(articleUrl, nodeUrl);
		if (!html) continue;

		let title = '';
		const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
		if (titleMatch) title = titleMatch[1].trim();

		const text = await extractText(html);
		if (text.length < 50) continue;
		articles.push({ title: title || file, full_text: text, url: articleUrl, source: 'Hainan Daily' });
	}

	console.log(`[HAINAN] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Generic HTMLRewriter fallback for sources without a known API pattern
async function scrapeGeneric(url: string, sourceName: string): Promise<ScrapedArticle[]> {
	const html = await fetchHtml(url, new URL(url).origin + '/');
	if (!html) return [];
	const title = (html.match(/<title>([^<]+)<\/title>/i) || [])[1]?.trim() || url;
	const text = await extractText(html);
	if (text.length < 100) {
		console.warn(`[GENERIC] ${sourceName}: only ${text.length} chars — likely JS-rendered, skipping`);
		return [];
	}
	console.log(`[GENERIC] ${sourceName}: ${text.length} chars`);
	return [{ title, full_text: text, url, source: sourceName }];
}

async function fetchAndParseSources(sources: Source[], yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const results = await Promise.allSettled([
		scrapeGuangxi(yyyy, mm, dd),
		scrapeHainan(sources.find(s => s.name === 'Hainan Daily')!.url),
		// Generic fallback for the rest — will silently return [] for JS-rendered ones
		...sources
			.filter(s => s.name !== 'Guangxi Daily' && s.name !== 'Hainan Daily')
			.map(s => scrapeGeneric(s.url, s.name)),
	]);
	return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
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

// ---------- AI ----------

// Shared helper: extract the text content from any Workers AI response shape.
// Default shape (no max_tokens): { response: string }
// With max_tokens:               { choices: [{ message: { content: string } }] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAiText(response: any): string | undefined {
	if (typeof response?.response === 'string') return response.response as string;
	return response?.choices?.[0]?.message?.content as string | undefined;
}

// Shared helper: find the best JSON array in a raw AI text string.
function extractJsonArray(rawText: string): unknown[] | null {
	const greedyMatch = rawText.match(/\[[\s\S]*\]/);
	const allMatches = [...rawText.matchAll(/\[[\s\S]*?\]/g)];
	const candidates = greedyMatch
		? [greedyMatch[0], ...allMatches.map(m => m[0])]
		: allMatches.map(m => m[0]);

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (Array.isArray(parsed) && parsed.length > 0) return parsed;
		} catch { /* try next */ }
	}
	return null;
}

// ── Pass 1: filter ────────────────────────────────────────────────────────────
// Send all article titles to AI. It evaluates each for geopolitical significance
// and returns a decision + reason for every article. This uses very few tokens
// (titles only, English output) so the filter pass is cheap on the free tier.

const FILTER_PROMPT = `You are a geopolitical intelligence analyst. You will receive a JSON array of Chinese newspaper article titles (index + title pairs).

Your task: evaluate every article for significance to international intelligence, foreign policy, and strategic monitoring.

Mark important: true for articles about:
- Military movements, exercises, procurement, or doctrine
- Senior leadership decisions, speeches, or personnel changes
- Foreign policy, diplomacy, or cross-border events
- Economic policy with international implications
- Technology programs with strategic or dual-use potential
- Significant social unrest, disasters, or events with political impact

Mark important: false for:
- Purely local infrastructure (roads, parks, municipal works)
- Sports, entertainment, cultural festivals
- Routine agriculture, weather, community services
- Advertising copy, editorial credits, routine notices

Return ONLY a valid JSON array — no markdown, no code fences, no explanation:
[
  {
    "index": 0,
    "title_en": "accurate English translation of the Chinese title",
    "important": true,
    "reason": "One sentence explaining why included or excluded"
  }
]

Every input article must appear in the output array. Your output must be parseable by JSON.parse().`;

interface FilterDecision {
	index: number;
	title_en: string;
	important: boolean;
	reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function filterArticlesWithAI(ai: any, articles: ScrapedArticle[]): Promise<FilterDecision[]> {
	const input = JSON.stringify(
		articles.map((a, i) => ({ index: i, title: a.title })),
	).slice(0, 3_000); // titles only — ~6k tokens input, ~2k tokens output → very cheap

	const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		max_tokens: 2048,
		messages: [
			{ role: 'system', content: FILTER_PROMPT },
			{ role: 'user', content: input },
		],
	});

	const rawText = extractAiText(response);
	if (!rawText) throw new Error(`Filter AI bad response shape: ${JSON.stringify(response).slice(0, 200)}`);

	const parsed = extractJsonArray(rawText);
	if (parsed && parsed.length > 0 && 'important' in (parsed[0] as object)) {
		const decisions = parsed as FilterDecision[];
		const importantCount = decisions.filter(d => d.important).length;
		console.log(`[FILTER AI] ${importantCount}/${decisions.length} articles marked important`);
		return decisions;
	}

	// Fallback: treat all as important so no data is lost
	console.warn('[FILTER AI] Could not parse filter response — treating all articles as important');
	return articles.map((a, i) => ({
		index: i,
		title_en: a.title,
		important: true,
		reason: 'Filter AI unavailable — included by default',
	}));
}

// ── Pass 2: deep analysis ─────────────────────────────────────────────────────
// Runs only on the important subset. Full translation + summary + category.

const ANALYSIS_PROMPT = `You are an intelligence analyst processing Chinese provincial newspaper articles.
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
		max_tokens: 4096, // default 256 truncates JSON arrays — must be set explicitly
		messages: [
			{ role: 'system', content: ANALYSIS_PROMPT },
			{
				role: 'user',
				content: JSON.stringify(
					articles.map((a) => ({
						title: a.title,
						full_text: a.full_text.slice(0, 400), // Chinese ~2 tok/char; fewer articles so we can give more per article
						url: a.url,
					})),
				).slice(0, 6_000), // ~12k tokens; system ~500 + output ~4k → fits in 24k ctx
			},
		],
	});

	// Workers AI (Llama): { response: string } by default; { choices:[...] } when max_tokens is set
	const rawText = extractAiText(response);
	if (!rawText) throw new Error(`Analysis AI bad response shape: ${JSON.stringify(response).slice(0, 200)}`);

	const parsed = extractJsonArray(rawText);
	if (parsed && parsed.length > 0 && 'title' in (parsed[0] as object)) {
		const results = parsed as AiArticle[];
		console.log(`[ANALYSIS AI] ${results.length} articles, first: ${results[0].title}`);
		return results;
	}

	console.warn('[ANALYSIS AI] Could not parse JSON array — using fallback');
	return articles.map(a => ({ title: a.title, summary: 'Analysis unavailable.', full_text_en: '', url: a.url, category: 'Uncategorized' }));
}

// ── Pass 3: cluster ───────────────────────────────────────────────────────────
// Groups articles that cover the same event across multiple newspapers into one
// cluster. The synthesised title/summary is shown on the card; individual source
// perspectives are shown inside the drawer.

const CLUSTER_PROMPT = `You are an intelligence analyst. You will receive a JSON array of analysed news articles, each with index, title, summary, and source newspaper.

Group articles that cover the SAME news event or topic into clusters. Articles about different topics must be in separate clusters.

Return ONLY a valid JSON array — no markdown, no code fences, no explanation:
[
  {
    "title": "Synthesised English headline drawing on all sources' angles",
    "summary": "2-3 sentence synthesis. If papers frame the story differently, briefly note that.",
    "category": "Political | Military | Economic | Technology | Social | Foreign Affairs",
    "article_indices": [0, 2]
  }
]

Rules:
- Every article index must appear in exactly one cluster
- Standalone unique articles form single-element clusters: "article_indices": [3]
- The synthesised summary should be richer than any single source's summary
- Your output must be parseable by JSON.parse()`;

interface ClusterResult {
	title: string;
	summary: string;
	category: string;
	article_indices: number[];
}

interface AiArticleWithSource extends AiArticle {
	source: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function clusterArticlesWithAI(ai: any, articles: AiArticleWithSource[]): Promise<ClusterResult[]> {
	if (articles.length <= 1) {
		return articles.map((a, i) => ({
			title: a.title,
			summary: a.summary,
			category: a.category,
			article_indices: [i],
		}));
	}

	const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		max_tokens: 2048,
		messages: [
			{ role: 'system', content: CLUSTER_PROMPT },
			{
				role: 'user',
				content: JSON.stringify(
					articles.map((a, i) => ({
						index: i,
						title: a.title,
						summary: a.summary.slice(0, 150),
						source: a.source,
					})),
				).slice(0, 4_000),
			},
		],
	});

	const rawText = extractAiText(response);
	if (!rawText) {
		console.warn('[CLUSTER AI] Bad response shape — treating each article as its own cluster');
		return articles.map((a, i) => ({ title: a.title, summary: a.summary, category: a.category, article_indices: [i] }));
	}

	const parsed = extractJsonArray(rawText);
	if (parsed && parsed.length > 0 && 'article_indices' in (parsed[0] as object)) {
		const clusters = parsed as ClusterResult[];
		// Validate every index is covered exactly once
		const covered = new Set(clusters.flatMap(c => c.article_indices));
		const allCovered = articles.every((_, i) => covered.has(i));
		if (allCovered) {
			const multiCount = clusters.filter(c => c.article_indices.length > 1).length;
			console.log(`[CLUSTER AI] ${clusters.length} clusters (${multiCount} multi-source) from ${articles.length} articles`);
			return clusters;
		}
	}

	console.warn('[CLUSTER AI] Invalid output (missing indices) — treating each article as its own cluster');
	return articles.map((a, i) => ({ title: a.title, summary: a.summary, category: a.category, article_indices: [i] }));
}

// ---------- email ----------

async function sendEmail(
	resendApiKey: string,
	from: string,
	to: string,
	date: string,
	articles: AiArticle[],
): Promise<void> {
	const htmlContent = `
<div style="font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 650px; margin: 0 auto; background-color: #f8fafc; padding: 24px; color: #0f172a;">

  <div style="border-bottom: 1px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px;">
    <p style="color: #ef4444; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 8px 0;">
      Intelligence Briefing
    </p>
    <h1 style="color: #0f172a; font-size: 36px; font-weight: 700; margin: 0; letter-spacing: -0.025em;">
      ${date}
    </h1>
    <p style="color: #64748b; font-size: 14px; margin-top: 8px; margin-bottom: 0;">
      Chinese Provincial Press Monitor &bull; ${articles.length} Articles &bull; CST Morning Edition
    </p>
  </div>

  ${articles.map((a) => `
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
		headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			from,
			to: [to],
			subject: `China Intel Briefing — ${date}`,
			html: htmlContent,
		}),
	});
	if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

// ---------- shared pipeline ----------

async function runPipeline(env: Env, fetchOnly: boolean): Promise<string> {
	const { yyyy, mm, dd } = getCSTDateParts();
	const trackingDate = `${yyyy}-${mm}-${dd}`;
	const db = drizzle(env.DB);

	// Idempotency: only enforce on cron runs. HTTP (fetch-only) test runs always proceed.
	if (!fetchOnly) {
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
	}

	const sources = buildSources(yyyy, mm, dd);
	let scrapedArticles: ScrapedArticle[] = [];
	let scrapeMode = 'puppeteer';

	if (fetchOnly) {
		// fetch-only mode: skip Puppeteer entirely (safe for testing — no Browser Rendering quota used)
		console.log('fetch-only mode — skipping Puppeteer, running fetch engine directly…');
		scrapeMode = 'fetch-only';
		scrapedArticles = await fetchAndParseSources(sources, yyyy, mm, dd);
		console.log(`Fetch engine yielded ${scrapedArticles.length} articles.`);
	} else {
		try {
			console.log('Attempting Puppeteer (Cloudflare Browser Rendering) scrape…');
			const browser = await puppeteer.launch(env.BROWSER);
			for (const { url, name } of sources) {
				const arts = await scrapeUrl(browser, url, name);
				scrapedArticles.push(...arts);
			}
			try { await browser.close(); } catch { /* browser may already be closed on crash */ }
			console.log(`Puppeteer scrape succeeded: ${scrapedArticles.length} articles.`);
		} catch (puppeteerErr) {
			console.warn(`Puppeteer failed (${(puppeteerErr as Error).message}). Falling back to fetch+HTMLRewriter…`);
			scrapeMode = 'fetch-fallback';
			scrapedArticles = await fetchAndParseSources(sources, yyyy, mm, dd);
			console.log(`Fetch fallback yielded ${scrapedArticles.length} articles.`);
		}
	}

	if (scrapedArticles.length === 0) {
		const msg = `No articles scraped for ${trackingDate} — both Puppeteer and fetch fallback returned nothing.`;
		console.warn(msg);
		return msg;
	}

	console.log(`Scrape mode: ${scrapeMode} — ${scrapedArticles.length} total articles.`);

	// ── Step 1: Delete previous day's temp articles (they've had their 24h) ──
	await env.DB.prepare(`DELETE FROM temp_articles WHERE tracking_date != ?`).bind(trackingDate).run();

	// ── Step 2: Pass 1 — filter all articles by title, get importance decisions ──
	console.log(`Pass 1: filtering ${scrapedArticles.length} articles by title…`);
	const filterDecisions = await filterArticlesWithAI(env.AI, scrapedArticles);

	// ── Step 3: Store ALL articles in temp_articles (visible in Today's Feed, 24h lifespan) ──
	for (let i = 0; i < scrapedArticles.length; i++) {
		const scraped = scrapedArticles[i];
		const decision = filterDecisions.find(d => d.index === i);
		await db.insert(tempArticles).values({
			trackingDate,
			title: scraped.title,
			titleEn: decision?.title_en ?? scraped.title,
			fullText: scraped.full_text,
			url: scraped.url,
			source: scraped.source,
			isImportant: decision?.important ? 1 : 0,
			importanceReason: decision?.reason ?? null,
		});
	}
	console.log(`Stored ${scrapedArticles.length} articles in temp_articles.`);

	// ── Step 4: Pass 2 — deep analysis on the important subset only ──
	const importantScraped = scrapedArticles.filter((_, i) => {
		const d = filterDecisions.find(fd => fd.index === i);
		return d ? d.important : true;
	});
	console.log(`Pass 2: deep analysis on ${importantScraped.length} important articles…`);
	const aiArticles = await analyseWithWorkersAI(env.AI, importantScraped);

	// ── Step 5: Upsert briefing parent record ──
	const rawScrapedText = scrapedArticles
		.map(a => `[${a.url}]\n${a.title}\n${a.full_text}`)
		.join('\n\n---\n\n');

	await db
		.insert(intelBriefings)
		.values({ trackingDate, rawScrapedText, aiAnalysisMarkdown: 'articles', emailStatus: 0 })
		.onConflictDoUpdate({
			target: intelBriefings.trackingDate,
			set: { rawScrapedText, aiAnalysisMarkdown: 'articles', emailStatus: 0 },
		});

	// ── Step 6: Pass 3 — cluster same-topic articles across sources ──
	const articlesWithSource: AiArticleWithSource[] = aiArticles.map((a, i) => ({
		...a,
		source: importantScraped[i]?.source ?? 'Unknown',
	}));
	console.log(`Pass 3: clustering ${articlesWithSource.length} articles…`);
	const clusters = await clusterArticlesWithAI(env.AI, articlesWithSource);

	// ── Step 7: Insert clusters, then articles with cluster_id set ──
	for (const cluster of clusters) {
		const clusterSources = [
			...new Set(cluster.article_indices.map(i => importantScraped[i]?.source).filter(Boolean) as string[]),
		];

		const clusterRows = await db
			.insert(intelClusters)
			.values({
				trackingDate,
				title: cluster.title,
				summary: cluster.summary,
				category: cluster.category,
				sources: JSON.stringify(clusterSources),
			})
			.returning({ id: intelClusters.id });

		const clusterId = clusterRows[0].id;

		for (const idx of cluster.article_indices) {
			const ai = aiArticles[idx];
			const scraped = importantScraped[idx];
			if (!ai || !scraped) continue;
			await db.insert(intelArticles).values({
				trackingDate,
				title: ai.title ?? scraped.title,
				summary: ai.summary,
				fullText: scraped.full_text,
				fullTextEn: ai.full_text_en,
				url: ai.url || scraped.url,
				category: ai.category ?? null,
				source: scraped.source ?? null,
				isPreserved: 0,
				clusterId,
			});
		}
	}

	console.log(`Saved ${clusters.length} clusters (${aiArticles.length} articles) to D1.`);

	// 30-day cleanup of unpreserved articles
	await env.DB.prepare(
		`DELETE FROM intel_articles WHERE created_at <= datetime('now', '-30 days') AND is_preserved = 0`,
	).run();

	if (env.ENABLE_EMAIL === 'true') {
		console.log('Email dispatch enabled — sending via Resend…');
		try {
			// Email one entry per cluster (synthesised title + summary); link to first article URL
			const emailArticles: AiArticle[] = clusters.map(c => ({
				title: c.title,
				summary: c.summary,
				full_text_en: '',
				url: aiArticles[c.article_indices[0]]?.url ?? '',
				category: c.category,
			}));
			await sendEmail(
				env.RESEND_API_KEY,
				env.RESEND_FROM_EMAIL,
				env.RESEND_TO_EMAIL,
				trackingDate,
				emailArticles,
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
	// HTTP trigger: fetch engine only — never touches Browser Rendering quota.
	// Use this for manual testing: curl https://scraper-worker.shubhanraj2002.workers.dev
	async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		try {
			const result = await runPipeline(env, true);
			return new Response(result, { status: 200 });
		} catch (error) {
			return new Response(`Pipeline error: ${(error as Error).message}`, { status: 500 });
		}
	},

	// Cron trigger: Puppeteer first → fetch fallback. Idempotency enforced.
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('Cron trigger fired. Starting pipeline…');
		await runPipeline(env, false);
	},
};
