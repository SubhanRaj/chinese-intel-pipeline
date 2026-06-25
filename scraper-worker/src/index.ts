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
		// www.yndaily.com: main portal, no WAF. Old epaper (yndaily.yunnan.cn) returns 403.
		{ name: 'Yunnan Daily',  url: `https://www.yndaily.com` },
		// www.scdaily.cn: main portal, 106 static text blocks. Old mobile SPA (4g.scdaily.cn) returned 123 chars.
		{ name: 'Sichuan Daily', url: `https://www.scdaily.cn` },
		{ name: 'Guangxi Daily', url: `https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001` },
		// hnrb.hunantoday.cn: static HTML with direct article links. Old SPA returned 7 chars.
		{ name: 'Hunan Daily',   url: `https://hnrb.hunantoday.cn` },
		// PC edition has cleaner article structure than the mobile pad/ URL
		{ name: 'Fujian Daily',  url: `https://fjrb.fjdaily.com/pc/col/${yyyy}${mm}/${dd}/node_01.html` },
		// southcn.com epaper: static HTML with article titles per section. Old SPA (#/) needed JS.
		{ name: 'Nanfang Daily', url: `https://epaper.southcn.com/nfdaily/html/${yyyy}${mm}/${dd}/node_A01.html` },
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

// -- Hainan Daily: two-level static HTML structure
//   Level 1: node_XXXXX.htm → l:[content_NODEID_ARTICLEID.htm, ...] (section pages)
//   Level 2: each section page → l:[content_NODEID_ARTICLEID.htm, ...] (actual articles)
// We scrape both levels: if a content file yields short text it's a section page, so we
// scan it for further content links and fetch those instead.
async function scrapeHainan(nodeUrl: string): Promise<ScrapedArticle[]> {
	const base = 'https://news.hndaily.cn';
	const nodeHtml = await fetchHtml(nodeUrl, base + '/');
	if (!nodeHtml) return [];

	// Extract content filenames from: l:["content_58464_19645177.htm", ...]
	function extractContentFiles(html: string): string[] {
		const files: string[] = [];
		for (const m of html.matchAll(/l:\[([^\]]+)\]/g)) {
			const found = m[1].match(/"(content_[^"]+\.htm)"/g);
			if (found) files.push(...found.map(f => f.replace(/"/g, '')));
		}
		return files;
	}

	const basePath = nodeUrl.substring(0, nodeUrl.lastIndexOf('/') + 1);
	const level1Files = extractContentFiles(nodeHtml);
	console.log(`[HAINAN] Level 1: ${level1Files.length} content files`);

	const articles: ScrapedArticle[] = [];
	const seen = new Set<string>();

	async function fetchArticle(file: string, referer: string): Promise<void> {
		if (seen.has(file)) return;
		seen.add(file);
		const articleUrl = basePath + file;
		const html = await fetchHtml(articleUrl, referer);
		if (!html) return;

		const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
		const title = titleMatch?.[1]?.trim() || file;
		const text = await extractText(html);

		if (text.length >= 200) {
			// Looks like a real article
			articles.push({ title, full_text: text, url: articleUrl, source: 'Hainan Daily' });
		} else {
			// Short text → likely a section page; drill one level deeper
			const level2Files = extractContentFiles(html);
			for (const f2 of level2Files.slice(0, 8)) {
				if (seen.has(f2)) continue;
				seen.add(f2);
				const url2 = basePath + f2;
				const html2 = await fetchHtml(url2, articleUrl);
				if (!html2) continue;
				const t2Match = html2.match(/<title>([^"<]+)<\/title>/i);
				const title2 = t2Match?.[1]?.trim() || f2;
				const text2 = await extractText(html2);
				if (text2.length >= 200) {
					articles.push({ title: title2, full_text: text2, url: url2, source: 'Hainan Daily' });
				}
			}
		}
	}

	// Fetch level-1 files (capped to avoid timeout)
	for (const file of level1Files.slice(0, 12)) {
		await fetchArticle(file, nodeUrl);
	}

	console.log(`[HAINAN] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Yunnan Daily: main portal (www.yndaily.com) — article pages live on this domain
// and are NOT WAF-blocked (only yndaily.yunnan.cn epaper is blocked).
// Article URLs follow: /html/{yyyy}/yaowenyunnan_{mmdd}/{id}.html
// Index page lists recent articles as <a href="…"> with title text.
async function scrapeYunnan(yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const base = 'https://www.yndaily.com';
	const indexHtml = await fetchHtml(base, base + '/');
	if (!indexHtml) return [];

	// Match article links on the same domain — exclude nav/utility pages
	const articleRe = new RegExp(
		`href=["'](${base}/html/${yyyy}/[^"']+\\.html)["'][^>]*>([^<]{5,120})`,
		'g',
	);
	const seen = new Set<string>();
	const links: { url: string; title: string }[] = [];
	for (const m of indexHtml.matchAll(articleRe)) {
		const url = m[1];
		// Skip archive/utility paths
		if (/about|contact|advert|mail|paper/.test(url)) continue;
		if (!seen.has(url)) {
			seen.add(url);
			links.push({ url, title: m[2].trim() });
		}
	}
	console.log(`[YUNNAN] Found ${links.length} article links`);

	const articles: ScrapedArticle[] = [];
	for (const { url, title } of links.slice(0, 20)) {
		const html = await fetchHtml(url, base + '/');
		if (!html) continue;
		const text = await extractText(html);
		if (text.length < 200) continue;
		articles.push({ title, full_text: text, url, source: 'Yunnan Daily' });
	}
	console.log(`[YUNNAN] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Hunan Daily: static HTML portal with direct article links
// Index: https://hnrb.hunantoday.cn
// Articles: https://hnrb.hunantoday.cn/article/{yyyymm}/{yyyymmddHHMMSSxxxxxxxxx}.html
// Each article page has full body text in <p> tags — no JS rendering required.
async function scrapeHunan(yyyy: string, mm: string): Promise<ScrapedArticle[]> {
	const base = 'https://hnrb.hunantoday.cn';
	const indexHtml = await fetchHtml(base, base + '/');
	if (!indexHtml) return [];

	// Extract article links for this month (yyyymm prefix keeps us to current edition)
	const articleRe = new RegExp(
		`href=["'](${base}/article/${yyyy}${mm}/[^"']+\\.html)["'][^>]*>([^<]{4,120})`,
		'g',
	);
	const seen = new Set<string>();
	const links: { url: string; title: string }[] = [];
	for (const m of indexHtml.matchAll(articleRe)) {
		if (!seen.has(m[1])) {
			seen.add(m[1]);
			links.push({ url: m[1], title: m[2].trim() });
		}
	}
	console.log(`[HUNAN] Found ${links.length} article links for ${yyyy}${mm}`);

	const articles: ScrapedArticle[] = [];
	for (const { url, title } of links.slice(0, 20)) {
		const html = await fetchHtml(url, base + '/');
		if (!html) continue;
		const text = await extractText(html);
		if (text.length < 200) continue;
		articles.push({ title, full_text: text, url, source: 'Hunan Daily' });
	}
	console.log(`[HUNAN] Scraped ${articles.length} articles with content`);
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

// ---------- RSS scraper ----------
// Used for JS-rendered sources that block fetch but publish RSS/Atom feeds via RSSHub.
// Falls back gracefully (returns []) if the feed is unreachable or unparseable.
// Confirmed routes (via https://rsshub.rssforever.com):
//   Hunan Daily  → /hnrb
//   Nanfang Daily → /southcn/nfapp/column/38  (Guangdong general column)

const RSSHUB_INSTANCES = [
	'https://rsshub.rssforever.com',
	'https://rsshub.app',
];

interface RssConfig {
	name: string;   // must match Source.name exactly
	path: string;   // RSSHub route path e.g. /hnrb
}

// Hunan Daily now has a dedicated fetch scraper (scrapeHunan) — no RSS needed.
// Nanfang Daily RSS kept as fallback; the static epaper URL is tried via scrapeGeneric first.
const RSS_CONFIGS: RssConfig[] = [
	{ name: 'Nanfang Daily', path: '/southcn/nfapp/column/38' },
];

// Extract text from an XML tag, handling CDATA wrappers.
function xmlText(xml: string, tag: string): string {
	const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i');
	return (xml.match(re)?.[1] ?? '').trim();
}

// Strip HTML tags from a string (RSS descriptions often contain markup).
function stripHtml(html: string): string {
	return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseRssXml(xml: string, sourceName: string): ScrapedArticle[] {
	const articles: ScrapedArticle[] = [];
	// Match both <item> (RSS) and <entry> (Atom)
	const itemRe = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/g;

	for (const m of xml.matchAll(itemRe)) {
		const item = m[1];
		const rawTitle = xmlText(item, 'title');
		// Atom uses <link href="…"/> or <link>…</link>; RSS uses <link>…</link>
		const link =
			(item.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1]) ||
			xmlText(item, 'link') ||
			xmlText(item, 'guid');
		// RSS uses <description>; Atom uses <summary> or <content>
		const desc =
			xmlText(item, 'description') ||
			xmlText(item, 'summary') ||
			xmlText(item, 'content');

		const title = stripHtml(rawTitle);
		if (!title || !link) continue;

		articles.push({
			title,
			full_text: stripHtml(desc),
			url: link,
			source: sourceName,
			parseType: 'rss',
		});
	}

	return articles.slice(0, 20);
}

async function scrapeRss(config: RssConfig): Promise<ScrapedArticle[]> {
	for (const instance of RSSHUB_INSTANCES) {
		const url = `${instance}${config.path}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8_000);
		try {
			const res = await fetch(url, {
				signal: controller.signal,
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; RSSReader/1.0)',
					'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
				},
			});
			clearTimeout(timer);
			if (!res.ok) {
				console.warn(`[RSS] ${config.name}: ${instance} returned ${res.status}`);
				continue;
			}
			const xml = await res.text();
			const articles = parseRssXml(xml, config.name);
			if (articles.length === 0) {
				console.warn(`[RSS] ${config.name}: ${instance} — feed parsed but no items found`);
				continue;
			}
			console.log(`[RSS] ${config.name}: ${articles.length} items via ${instance}`);
			return articles;
		} catch (err) {
			clearTimeout(timer);
			console.warn(`[RSS] ${config.name}: ${instance} failed — ${(err as Error).message}`);
		}
	}
	console.warn(`[RSS] ${config.name}: all instances failed — skipping`);
	return [];
}

// After RSS scraping, try to fetch each article's URL to get full text.
// RSS feeds only provide title + short excerpt; fetching the source URL often yields the
// complete article. Falls back silently to the RSS excerpt if the fetch fails or is too short.
async function enrichRssArticles(articles: ScrapedArticle[]): Promise<ScrapedArticle[]> {
	return Promise.all(
		articles.map(async (article) => {
			if (article.parseType !== 'rss' || !article.url) return article;
			try {
				const html = await fetchHtml(article.url, article.url);
				if (!html) return article;
				const text = await extractText(html);
				if (text.length < 200) return article;
				console.log(`[RSS ENRICH] ${article.source}: fetched full text for "${article.title.slice(0, 40)}" (${text.length} chars)`);
				return { ...article, full_text: text, parseType: 'full' as const };
			} catch {
				return article;
			}
		}),
	);
}

async function fetchAndParseSources(sources: Source[], yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	// Dedicated scrapers: Guangxi (epaper API), Hainan (two-level static HTML), Hunan (article portal).
	// Generic HTMLRewriter for: Yunnan, Sichuan, Fujian, Nanfang — all now have static-HTML URLs.
	// RSS fallback kept for Nanfang only (epaper may be thin; RSS adds more article variety).
	const dedicatedNames = new Set(['Yunnan Daily', 'Guangxi Daily', 'Hainan Daily', 'Hunan Daily']);
	const rssSourceNames = new Set(RSS_CONFIGS.map(c => c.name));
	const results = await Promise.allSettled([
		scrapeYunnan(yyyy, mm, dd),
		scrapeGuangxi(yyyy, mm, dd),
		scrapeHainan(sources.find(s => s.name === 'Hainan Daily')!.url),
		scrapeHunan(yyyy, mm),
		// Generic fetch fallback for sources without a dedicated scraper or RSS route
		...sources
			.filter(s => !dedicatedNames.has(s.name) && !rssSourceNames.has(s.name))
			.map(s => scrapeGeneric(s.url, s.name)),
		// RSS fallback for Nanfang (kept as supplement to the static epaper scrape)
		// RSS fallback for JS-rendered sources with confirmed RSSHub routes
		...RSS_CONFIGS.map(cfg => scrapeRss(cfg)),
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
	parseType?: 'full' | 'rss';
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

Mark important: true ONLY for articles that clearly involve:
- Military movements, exercises, procurement, weapons, or doctrine
- Senior national/provincial leadership decisions, speeches, or personnel changes (Xi Jinping, Politburo, ministers, provincial party secretaries)
- Foreign policy, bilateral diplomacy, cross-border events, or international agreements
- Economic policy with direct international implications (sanctions, trade, foreign investment rules)
- Technology programs with strategic or dual-use potential (satellites, AI, semiconductors, defence tech)
- Significant unrest, disasters, or politically sensitive events

Mark important: false for:
- Local infrastructure, construction, roads, parks, municipal services
- Sports, entertainment, arts, tourism, cultural festivals
- Routine agriculture, weather, education, community welfare
- Advertising, editorial credits, administrative notices
- Provincial economic statistics without international angle
- Party study campaigns, Xi Jinping quote collections, ideological reading materials
- Trade fairs, business expos, signing ceremonies with purely domestic parties
- Local government meetings with no foreign or national-security dimension

Be selective: aim for roughly 20–30% of articles as important. When in doubt, mark false.

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
	// Build input article-by-article so we never truncate mid-JSON.
	// Each article ~400 chars → budget 5,800 chars total for ~14 articles safely.
	const inputArticles: { title: string; full_text: string; url: string }[] = [];
	let budget = 5_800;
	for (const a of articles) {
		const entry = { title: a.title, full_text: a.full_text.slice(0, 400), url: a.url };
		const len = JSON.stringify(entry).length + 2; // +2 for comma/bracket overhead
		if (budget - len < 0) break;
		inputArticles.push(entry);
		budget -= len;
	}
	console.log(`[ANALYSIS AI] Sending ${inputArticles.length} of ${articles.length} important articles (budget-capped)`);

	const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		max_tokens: 4096, // default 256 truncates JSON arrays — must be set explicitly
		messages: [
			{ role: 'system', content: ANALYSIS_PROMPT },
			{ role: 'user', content: JSON.stringify(inputArticles) },
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

const DASHBOARD_URL = 'https://dashboard.shubhanraj2002.workers.dev';

async function sendEmail(
	resendApiKey: string,
	from: string,
	to: string,
	date: string,
	articles: AiArticle[],
): Promise<void> {
	// Table-based layout — Gmail strips <style> blocks so all CSS must be inline.
	// max-width 580px + width:100% makes it readable on both desktop and mobile Gmail.
	const articleRows = articles.map(a => {
		const isHigh = a.summary?.includes('[HIGH]');
		const summary = (a.summary ?? '').replace(/\[HIGH\]/g, '').trim();
		const category = a.category ?? '';
		return `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid #f1f5f9">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td style="padding-bottom:6px">
                ${category ? `<span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8">${category}</span>` : ''}
                ${isHigh ? `&nbsp;<span style="display:inline-block;padding:2px 7px;background:#ef4444;color:#ffffff;font-size:10px;font-weight:700;text-transform:uppercase;border-radius:4px;vertical-align:middle">HIGH</span>` : ''}
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:8px">
                <p style="margin:0;font-size:16px;font-weight:600;color:#0f172a;line-height:1.4">${a.title ?? ''}</p>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:12px">
                <p style="margin:0;font-size:14px;color:#475569;line-height:1.65">${summary}</p>
              </td>
            </tr>
            <tr>
              <td>
                <a href="${DASHBOARD_URL}" target="_blank" style="font-size:13px;font-weight:600;color:#ef4444;text-decoration:none">View in Dashboard →</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
	}).join('');

	const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>China Intel Briefing — ${date}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;-webkit-text-size-adjust:100%">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f8fafc">
    <tr>
      <td align="center" style="padding:24px 16px">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:580px">

          <!-- Header -->
          <tr>
            <td style="padding-bottom:20px;border-bottom:2px solid #e2e8f0">
              <p style="margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#ef4444;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">Intelligence Briefing</p>
              <h1 style="margin:0 0 6px;font-size:26px;font-weight:700;color:#0f172a;letter-spacing:-0.02em;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">${date}</h1>
              <p style="margin:0;font-size:13px;color:#64748b;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">Chinese Provincial Press Monitor &bull; ${articles.length} stories &bull; CST Morning Edition</p>
            </td>
          </tr>

          <!-- Stories -->
          <tr>
            <td style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                ${articleRows}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:24px;text-align:center">
              <a href="${DASHBOARD_URL}" target="_blank" style="display:inline-block;padding:10px 24px;background:#ef4444;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;border-radius:6px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">Open Full Briefing</a>
              <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">Automated briefing &bull; Cloudflare Workers AI &bull; Chinese Provincial Press</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

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
		scrapedArticles = await enrichRssArticles(scrapedArticles);
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
			// RSS enrichment even after Puppeteer (Puppeteer won't cover Hunan/Nanfang if they
			// are in rssSourceNames — those are skipped by the Puppeteer loop via fetchAndParseSources
			// but the cron path calls scrapeUrl per source, so run enrichment on the full set)
			scrapedArticles = await enrichRssArticles(scrapedArticles);
			console.log(`Puppeteer scrape succeeded: ${scrapedArticles.length} articles.`);
		} catch (puppeteerErr) {
			console.warn(`Puppeteer failed (${(puppeteerErr as Error).message}). Falling back to fetch+HTMLRewriter…`);
			scrapeMode = 'fetch-fallback';
			scrapedArticles = await fetchAndParseSources(sources, yyyy, mm, dd);
			scrapedArticles = await enrichRssArticles(scrapedArticles);
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
			parseType: scraped.parseType ?? 'full',
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

		// Backfill cluster_id on temp_articles for each article in this cluster
		for (const idx of cluster.article_indices) {
			const scraped = importantScraped[idx];
			if (scraped) {
				await env.DB.prepare(
					`UPDATE temp_articles SET cluster_id = ? WHERE tracking_date = ? AND url = ?`,
				).bind(clusterId, trackingDate, scraped.url).run();
			}
		}

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
				parseType: scraped.parseType ?? 'full',
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
