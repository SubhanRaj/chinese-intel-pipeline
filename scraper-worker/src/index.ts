import { drizzle } from 'drizzle-orm/d1';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { intelBriefings, intelArticles, intelClusters, tempArticles, users } from './db/schema';

export interface Env {
	DB: D1Database;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	AI: any;
	// HTTP trigger protection — set as a CF secret. If set, GET requests must include
	// "Authorization: Bearer <SCRAPER_SECRET>". Cron triggers bypass this check.
	SCRAPER_SECRET?: string;
	RESEND_API_KEY: string;
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
	for (const { code, xuhao, title } of links.slice(0, 8)) {
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
			for (const f2 of level2Files.slice(0, 2)) {
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
	for (const file of level1Files.slice(0, 5)) {
		await fetchArticle(file, nodeUrl);
	}

	console.log(`[HAINAN] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Yunnan Daily: main portal (www.yndaily.com) — article pages live on this domain
// and are NOT WAF-blocked (only yndaily.yunnan.cn epaper is blocked).
// Article URLs follow: /html/{yyyy}/yaowenyunnan_{mmdd}/{id}.html (relative hrefs on homepage)
async function scrapeYunnan(yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const base = 'https://www.yndaily.com';
	const indexHtml = await fetchHtml(base, base + '/');
	if (!indexHtml) return [];

	// Homepage serves relative hrefs like /html/2026/yaowenyunnan_0627/143388.html
	// Match relative paths under /html/{yyyy}/ and resolve to absolute URLs
	const articleRe = new RegExp(
		`href=["'](/html/${yyyy}/[^"']+\\.html)["'][^>]*>([^<]{5,120})`,
		'g',
	);
	const seen = new Set<string>();
	const links: { url: string; title: string }[] = [];
	for (const m of indexHtml.matchAll(articleRe)) {
		const url = base + m[1];
		if (/about|contact|advert|mail|paper/.test(url)) continue;
		if (!seen.has(url)) {
			seen.add(url);
			links.push({ url, title: m[2].trim() });
		}
	}
	console.log(`[YUNNAN] Found ${links.length} article links`);

	const articles: ScrapedArticle[] = [];
	for (const { url, title } of links.slice(0, 5)) {
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
	for (const { url, title } of links.slice(0, 6)) {
		const html = await fetchHtml(url, base + '/');
		if (!html) continue;
		const text = await extractText(html);
		if (text.length < 200) continue;
		articles.push({ title, full_text: text, url, source: 'Hunan Daily' });
	}
	console.log(`[HUNAN] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Nanfang Daily: static epaper (epaper.southcn.com) with content links on epaper.nfnews.com
// Index: https://epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html
// Articles: https://epaper.nfnews.com/nfdaily/html/{yyyymm}/{dd}/content_*.html (absolute links)
async function scrapeNanfang(yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const yyyymm = `${yyyy}${mm}`;
	const indexUrl = `https://epaper.southcn.com/nfdaily/html/${yyyymm}/${dd}/node_A01.html`;
	const indexHtml = await fetchHtml(indexUrl, 'https://epaper.southcn.com/');
	if (!indexHtml) return [];

	// Content links are absolute URLs on epaper.nfnews.com
	const contentRe = /https:\/\/epaper\.nfnews\.com\/nfdaily\/html\/[^"']+\/content_\d+\.html/g;
	const seen = new Set<string>();
	const articleUrls: string[] = [];
	for (const m of indexHtml.matchAll(contentRe)) {
		if (!seen.has(m[0])) {
			seen.add(m[0]);
			articleUrls.push(m[0]);
		}
	}
	console.log(`[NANFANG] Found ${articleUrls.length} article links`);

	const articles: ScrapedArticle[] = [];
	for (const url of articleUrls.slice(0, 6)) {
		const html = await fetchHtml(url, indexUrl);
		if (!html) continue;
		const titleMatch = html.match(/<title>([^<_]+)/i);
		const title = titleMatch?.[1]?.trim() || url;
		const text = await extractText(html);
		if (text.length < 100) continue;
		articles.push({ title, full_text: text, url, source: 'Nanfang Daily' });
	}
	console.log(`[NANFANG] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Fujian Daily: static epaper with content article links
// Index: https://fjrb.fjdaily.com/pc/col/{yyyymm}/{dd}/node_01.html
// Articles: relative ../../../con/{yyyymm}/{dd}/content_*.html → https://fjrb.fjdaily.com/pc/con/...
async function scrapeFujian(yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const yyyymm = `${yyyy}${mm}`;
	const indexUrl = `https://fjrb.fjdaily.com/pc/col/${yyyymm}/${dd}/node_01.html`;
	const indexHtml = await fetchHtml(indexUrl, 'https://fjrb.fjdaily.com/');
	if (!indexHtml) return [];

	// Relative links: ../../../con/{yyyymm}/{dd}/content_*.html → /pc/con/{yyyymm}/{dd}/content_*.html
	const contentRe = new RegExp(`\\.\\./\\.\\./\\.\\./con/${yyyymm}/${dd}/(content_\\d+\\.html)`, 'g');
	const seen = new Set<string>();
	const articleUrls: string[] = [];
	for (const m of indexHtml.matchAll(contentRe)) {
		const url = `https://fjrb.fjdaily.com/pc/con/${yyyymm}/${dd}/${m[1]}`;
		if (!seen.has(url)) {
			seen.add(url);
			articleUrls.push(url);
		}
	}
	console.log(`[FUJIAN] Found ${articleUrls.length} article links`);

	const articles: ScrapedArticle[] = [];
	for (const url of articleUrls.slice(0, 6)) {
		const html = await fetchHtml(url, indexUrl);
		if (!html) continue;
		const titleMatch = html.match(/<title>([^<\-–—]+)/i);
		const title = titleMatch?.[1]?.trim() || url;
		const text = await extractText(html);
		if (text.length < 100) continue;
		articles.push({ title, full_text: text, url, source: 'Fujian Daily' });
	}
	console.log(`[FUJIAN] Scraped ${articles.length} articles with content`);
	return articles;
}

// -- Generic HTMLRewriter fallback for sources without a known API pattern
async function fetchAndParseSources(sources: Source[], yyyy: string, mm: string, dd: string): Promise<ScrapedArticle[]> {
	const results = await Promise.allSettled([
		scrapeYunnan(yyyy, mm, dd),
		scrapeGuangxi(yyyy, mm, dd),
		scrapeHainan(sources.find(s => s.name === 'Hainan Daily')!.url),
		scrapeHunan(yyyy, mm),
		scrapeNanfang(yyyy, mm, dd),
		scrapeFujian(yyyy, mm, dd),
		// Sichuan Daily is a JS-SPA with no static article URL pattern — no articles fetched.
	]);
	return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ---------- article type ----------

interface ScrapedArticle {
	title: string;
	full_text: string;
	url: string;
	source: string;
	parseType?: 'full' | 'rss';
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

// ── Combined Pass: filter + analyse ──────────────────────────────────────────
// Sends all articles with title + body snippet so importance is judged on actual
// content rather than titles alone. Important articles get full analysis in the
// same call; unimportant articles just get a translated title and a reason.

const COMBINED_PROMPT = `You are a geopolitical intelligence analyst processing Chinese provincial newspaper articles.

You will receive a JSON array where each element has "index", "title" (Chinese), and "snippet" (opening portion of the article body in Chinese).

For EVERY article return a JSON object with:
- "index": same integer as input
- "title_en": accurate English translation of the Chinese title
- "important": true or false
- "reason": one sentence explaining why included or excluded
- For important: true articles ONLY — also include:
  - "summary": 2–3 sentence geopolitical analysis in English; flag high-significance items with [HIGH]
  - "full_text_en": faithful English translation of the snippet
  - "category": exactly one of "Political", "Military", "Economic", "Technology", "Social", "Foreign Affairs"
- For important: false articles set "summary", "full_text_en", "category" to ""

Mark important: true for articles that clearly involve:
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

Aim for 40–60% of articles as important. Use the snippet to make a well-informed decision — when in doubt, mark important.

Return ONLY a valid JSON array — no markdown, no code fences, no explanation. Every input article must appear in the output. Your output must be parseable by JSON.parse().`;

interface CombinedDecision {
	index: number;
	title_en: string;
	important: boolean;
	reason: string;
	summary: string;
	full_text_en: string;
	category: string;
}

interface AiArticle {
	title: string;
	summary: string;
	full_text_en: string;
	url: string;
	category: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function filterAndAnalyseWithAI(ai: any, articles: ScrapedArticle[]): Promise<CombinedDecision[]> {
	// Build input article-by-article: title + 250-char snippet per article.
	// Budget 10,000 chars covers ~40 articles and stays safely within the model context window.
	const inputArticles: { index: number; title: string; snippet: string }[] = [];
	let budget = 10_000;
	for (let i = 0; i < articles.length; i++) {
		const a = articles[i];
		const entry = { index: i, title: a.title, snippet: a.full_text.slice(0, 250) };
		const len = JSON.stringify(entry).length + 2;
		if (budget - len < 0) break;
		inputArticles.push(entry);
		budget -= len;
	}
	console.log(`[COMBINED AI] Sending ${inputArticles.length} of ${articles.length} articles`);

	const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		max_tokens: 14000,
		messages: [
			{ role: 'system', content: COMBINED_PROMPT },
			{ role: 'user', content: JSON.stringify(inputArticles) },
		],
	});

	const rawText = extractAiText(response);
	if (!rawText) throw new Error(`Combined AI bad response shape: ${JSON.stringify(response).slice(0, 200)}`);

	const parsed = extractJsonArray(rawText);
	if (parsed && parsed.length > 0 && 'important' in (parsed[0] as object)) {
		const decisions = parsed as CombinedDecision[];
		const importantCount = decisions.filter(d => d.important).length;
		console.log(`[COMBINED AI] ${importantCount}/${decisions.length} articles marked important`);
		return decisions;
	}

	// Fallback: treat all articles as important with stub analysis so no data is lost
	console.warn('[COMBINED AI] Could not parse response — treating all articles as important');
	return articles.map((a, i) => ({
		index: i,
		title_en: a.title,
		important: true,
		reason: 'Combined AI unavailable — included by default',
		summary: 'Analysis unavailable.',
		full_text_en: '',
		category: 'Uncategorized',
	}));
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
				).slice(0, 12_000),
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
		const covered = new Set(clusters.flatMap(c => c.article_indices));
		// Add uncovered articles as single-item clusters rather than discarding all groupings
		const uncovered = articles.map((_, i) => i).filter(i => !covered.has(i));
		if (uncovered.length > 0) {
			console.warn(`[CLUSTER AI] ${uncovered.length} articles not covered by AI — adding as single-item clusters`);
			for (const i of uncovered) {
				const a = articles[i];
				clusters.push({ title: a.title, summary: a.summary, category: a.category, article_indices: [i] });
			}
		}
		const multiCount = clusters.filter(c => c.article_indices.length > 1).length;
		console.log(`[CLUSTER AI] ${clusters.length} clusters (${multiCount} multi-source) from ${articles.length} articles`);
		return clusters;
	}

	console.warn('[CLUSTER AI] Invalid output (missing indices) — treating each article as its own cluster');
	return articles.map((a, i) => ({ title: a.title, summary: a.summary, category: a.category, article_indices: [i] }));
}

// ---------- email ----------

const DASHBOARD_URL = 'https://dashboard.shubhanraj2002.workers.dev';

async function sendEmail(
	resendApiKey: string,
	from: string,
	to: string | string[],
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
			to: Array.isArray(to) ? to : [to],
			subject: `China Intel Briefing — ${date}`,
			html: htmlContent,
		}),
	});
	if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

// ---------- shared pipeline ----------

async function runPipeline(env: Env, isCron: boolean): Promise<string> {
	const { yyyy, mm, dd } = getCSTDateParts();
	const trackingDate = `${yyyy}-${mm}-${dd}`;
	const db = drizzle(env.DB);

	// ── Idempotency / fallback guard ──────────────────────────────────────────
	// Both cron and curl skip if today's data already exists.
	// This prevents curl (triggered manually or accidentally) from overwriting a
	// successful cron run and consuming the daily neuron budget a second time.
	// To force a re-run: delete today's temp_articles via wrangler first.
	const existingFeed = await env.DB
		.prepare(`SELECT COUNT(*) as cnt FROM temp_articles WHERE tracking_date = ?`)
		.bind(trackingDate)
		.first<{ cnt: number }>();
	if (existingFeed && existingFeed.cnt > 0) {
		const msg = `[${isCron ? 'CRON' : 'HTTP'}] Today's feed already has ${existingFeed.cnt} articles for ${trackingDate} — skipping to preserve data and neuron budget.`;
		console.log(msg);
		return msg;
	}
	// Cron also checks the briefing record in case temp_articles was manually cleared
	if (isCron) {
		const existing = await db
			.select()
			.from(intelBriefings)
			.where(eq(intelBriefings.trackingDate, trackingDate))
			.limit(1);
		if (existing.length > 0 && existing[0].aiAnalysisMarkdown) {
			const msg = `[CRON] Briefing record exists for ${trackingDate} — skipping.`;
			console.log(msg);
			return msg;
		}
	}

	// ── Scrape ───────────────────────────────────────────────────────────────
	const sources = buildSources(yyyy, mm, dd);
	console.log(`[PIPELINE] Fetch engine: scraping ${sources.length} sources…`);
	let scrapedArticles: ScrapedArticle[] = [];
	try {
		scrapedArticles = await fetchAndParseSources(sources, yyyy, mm, dd);
		console.log(`[PIPELINE] Fetch engine yielded ${scrapedArticles.length} articles.`);
	} catch (scrapeErr) {
		console.error('[PIPELINE] Scraping failed:', scrapeErr);
		return `Pipeline failed at scrape: ${(scrapeErr as Error).message}`;
	}

	if (scrapedArticles.length === 0) {
		const msg = `[PIPELINE] No articles scraped for ${trackingDate}.`;
		console.warn(msg);
		return msg;
	}

	// ── Step 1: AI Pass 1 — filter + analyse ─────────────────────────────────
	// IMPORTANT: temp_articles is NOT cleared yet. If this call throws, the old
	// feed remains intact (yesterday's data or empty) rather than being wiped.
	console.log(`[PIPELINE] AI Pass 1: filter + analyse ${scrapedArticles.length} articles…`);
	let combinedDecisions: CombinedDecision[];
	try {
		combinedDecisions = await filterAndAnalyseWithAI(env.AI, scrapedArticles);
	} catch (aiErr) {
		// Log full error for CF Workers observability (visible in dashboard logs)
		console.error('[PIPELINE] AI Pass 1 failed — temp_articles NOT cleared, old feed preserved:', aiErr);
		return `Pipeline failed at AI pass 1: ${(aiErr as Error).message}`;
	}

	// ── Step 2: Clear + repopulate temp_articles (AI succeeded) ──────────────
	// Only clear NOW that we have fresh AI output — a failed AI call above won't
	// leave an empty feed since we returned early.
	await env.DB.prepare(`DELETE FROM temp_articles WHERE tracking_date = ?`).bind(trackingDate).run();
	await env.DB.prepare(`DELETE FROM temp_articles WHERE tracking_date != ?`).bind(trackingDate).run();

	for (let i = 0; i < scrapedArticles.length; i++) {
		const scraped = scrapedArticles[i];
		const decision = combinedDecisions.find(d => d.index === i);
		try {
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
		} catch (insertErr) {
			console.error(`[PIPELINE] temp_articles insert failed for "${scraped.title}":`, insertErr);
		}
	}
	console.log(`[PIPELINE] Stored ${scrapedArticles.length} articles in temp_articles.`);

	// ── Step 3: Collect important articles ───────────────────────────────────
	const importantDecisions = combinedDecisions.filter(d => d.important);
	const importantScraped = importantDecisions.map(d => scrapedArticles[d.index]).filter(Boolean);
	const aiArticles: AiArticle[] = importantDecisions.map((d) => ({
		title: d.title_en,
		summary: d.summary || 'Analysis unavailable.',
		full_text_en: d.full_text_en || '',
		url: scrapedArticles[d.index]?.url ?? '',
		category: d.category || 'Uncategorized',
	}));
	console.log(`[PIPELINE] ${importantDecisions.length} articles marked important.`);

	// ── Step 4: Upsert briefing parent record ────────────────────────────────
	const rawScrapedText = scrapedArticles
		.map(a => `[${a.url}]\n${a.title}\n${a.full_text}`)
		.join('\n\n---\n\n');
	try {
		await db
			.insert(intelBriefings)
			.values({ trackingDate, rawScrapedText, aiAnalysisMarkdown: 'articles', emailStatus: 0 })
			.onConflictDoUpdate({
				target: intelBriefings.trackingDate,
				set: { rawScrapedText, aiAnalysisMarkdown: 'articles', emailStatus: 0 },
			});
	} catch (briefingErr) {
		console.error('[PIPELINE] intel_briefings upsert failed:', briefingErr);
		// Non-fatal — continue so intel_articles and clusters are still saved
	}

	// ── Step 5: AI Pass 2 — cluster ──────────────────────────────────────────
	const articlesWithSource: AiArticleWithSource[] = aiArticles.map((a, i) => ({
		...a,
		source: importantScraped[i]?.source ?? 'Unknown',
	}));
	console.log(`[PIPELINE] AI Pass 2: clustering ${articlesWithSource.length} articles…`);
	let clusters: ClusterResult[];
	try {
		clusters = await clusterArticlesWithAI(env.AI, articlesWithSource);
	} catch (clusterErr) {
		// Clustering failure is non-fatal: save articles as individual single-item clusters
		console.error('[PIPELINE] AI Pass 2 failed — saving articles without clusters:', clusterErr);
		clusters = aiArticles.map((a, i) => ({
			title: a.title,
			summary: a.summary,
			category: a.category,
			article_indices: [i],
		}));
	}

	// ── Step 6: Persist intel data ───────────────────────────────────────────
	try {
		await env.DB.prepare(`DELETE FROM intel_articles WHERE tracking_date = ? AND is_preserved = 0`).bind(trackingDate).run();
		await env.DB.prepare(`DELETE FROM intel_clusters WHERE tracking_date = ?`).bind(trackingDate).run();

		for (const cluster of clusters) {
			const clusterSources = [
				...new Set(cluster.article_indices.map(i => importantScraped[i]?.source).filter(Boolean) as string[]),
			];
			const clusterRows = await db
				.insert(intelClusters)
				.values({ trackingDate, title: cluster.title, summary: cluster.summary, category: cluster.category, sources: JSON.stringify(clusterSources) })
				.returning({ id: intelClusters.id });
			const clusterId = clusterRows[0].id;

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
		console.log(`[PIPELINE] Saved ${clusters.length} clusters (${aiArticles.length} articles) to D1.`);
	} catch (saveErr) {
		console.error('[PIPELINE] Failed to save intel data to D1:', saveErr);
		// temp_articles is already populated — Today's Feed will still work
	}

	// 30-day cleanup of unpreserved articles
	try {
		await env.DB.prepare(
			`DELETE FROM intel_articles WHERE created_at <= datetime('now', '-30 days') AND is_preserved = 0`,
		).run();
	} catch { /* non-fatal */ }

	// ── Step 7: Email ─────────────────────────────────────────────────────────
	// Send to all users who have email_notifications = 1 in the users table.
	try {
		const recipients = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.emailNotifications, 1));

		if (recipients.length > 0) {
			const toList = recipients.map(r => r.email);
			console.log(`[PIPELINE] Sending email to ${toList.length} recipient(s)…`);
			const emailArticles: AiArticle[] = clusters.map(c => ({
				title: c.title,
				summary: c.summary,
				full_text_en: '',
				url: aiArticles[c.article_indices[0]]?.url ?? '',
				category: c.category,
			}));
			await sendEmail(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL, toList, trackingDate, emailArticles);
			await db.update(intelBriefings).set({ emailStatus: 1 }).where(eq(intelBriefings.trackingDate, trackingDate));
			console.log('[PIPELINE] Email sent successfully.');
		} else {
			console.log('[PIPELINE] No users with email notifications enabled — skipping email.');
		}
	} catch (emailErr) {
		console.error('[PIPELINE] Email step failed (briefing already saved):', emailErr);
	}

	return `Pipeline completed for ${trackingDate} — ${aiArticles.length} important articles in ${clusters.length} clusters.`;
}

// ---------- handlers ----------

export default {
	// HTTP trigger: fallback mode — skips if today's feed already exists (cron already ran).
	// Protected by SCRAPER_SECRET bearer token when the secret is configured.
	// To force a re-run: delete today's temp_articles via wrangler, then curl again.
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		// Bearer token guard — only enforced when SCRAPER_SECRET is set as a CF secret
		if (env.SCRAPER_SECRET) {
			const auth = request.headers.get('Authorization') ?? '';
			if (auth !== `Bearer ${env.SCRAPER_SECRET}`) {
				return new Response('Unauthorized', { status: 401 });
			}
		}
		try {
			const result = await runPipeline(env, false);
			return new Response(result, { status: 200 });
		} catch (error) {
			console.error('[HANDLER] Unhandled pipeline error:', error);
			return new Response(`Pipeline error: ${(error as Error).message}`, { status: 500 });
		}
	},

	// Cron trigger: same fallback guard + extra check on briefing record.
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('[CRON] Trigger fired. Starting pipeline…');
		try {
			await runPipeline(env, true);
		} catch (error) {
			console.error('[CRON] Unhandled pipeline error:', error);
		}
	},
};
