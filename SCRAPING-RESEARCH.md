# Scraping Research — Chinese Provincial Press Pipeline

This document records all empirical findings, dead ends, and decisions made while figuring out how to reliably scrape the seven Chinese provincial newspapers. It exists so future work and future debugging don't have to repeat the same experiments.

---

## The Seven Sources

| # | Newspaper | Province | Working URL |
|---|-----------|----------|-------------|
| 1 | Yunnan Daily (云南日报) | Yunnan | `www.yndaily.com` |
| 2 | Sichuan Daily (四川日报) | Sichuan | `www.scdaily.cn` (JS SPA — no article content via fetch) |
| 3 | Guangxi Daily (广西日报) | Guangxi | `ssw.gxrb.com.cn/json/interface/epaper/api.php?` |
| 4 | Hunan Daily (湖南日报) | Hunan | `hnrb.hunantoday.cn` |
| 5 | Fujian Daily (福建日报) | Fujian | `fjrb.fjdaily.com/pc/col/{yyyymm}/{dd}/node_01.html` |
| 6 | Nanfang Daily (南方日报) | Guangdong | `epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html` |
| 7 | Hainan Daily (海南日报) | Hainan | `news.hndaily.cn/h5/html5/{yyyy}-{mm}/{dd}/node_58471.htm` |

---

## Approach 1 — Cloudflare Browser Rendering (Puppeteer)

### What it is

`@cloudflare/puppeteer` connects to Cloudflare's hosted headless Chromium via the Browser Rendering (Browser Run) service. It's the only browser-automation option inside a Cloudflare Worker.

### Why it was removed (2026-06-27)

**It was both unreliable AND worse than the fetch engine:**

1. **Free plan hard limits** (sourced from `developers.cloudflare.com/browser-rendering/platform/limits/`):
   - 10 minutes/day browser time
   - 3 concurrent browser sessions
   - 1 new instance per 20 seconds

2. **Generic `scrapeUrl()` quality was worse than dedicated scrapers.** The Puppeteer implementation used a single generic function: open index page → follow up to 25 random sub-links → open each in a new tab. It had no knowledge of Guangxi's API format, Hainan's `l:[…]` structure, Fujian's `../../../con/` paths, etc. Our dedicated fetch scrapers are purpose-built for each source and consistently produce better results.

3. **7 sources × up to 25 sub-pages each = ~175 tab navigations.** Worst case: 7 × (30 s + 25 × 20 s) ≈ 60 minutes. The 10-min free cap would be exhausted every run.

4. **Bot flag is permanent.** CF docs: *"Requests from Browser Run will always be identified as a bot regardless of the user agent set."* Any Chinese site with anti-bot detection would reject every request.

5. **Local dev `wrangler dev --remote --test-scheduled` always timed out.** `waitUntil()` tasks cancelled after ~115s. Even if Puppeteer launched, `networkidle2` on 7 sources + sub-pages never completes in the dev environment.

### Final verdict

Puppeteer removed from the pipeline entirely as of 2026-06-27. The BROWSER binding removed from wrangler.jsonc. `scrapeUrl()` function deleted. `@cloudflare/puppeteer` import removed.

The fetch engine covers 6 of 7 sources with dedicated scrapers producing better-quality output than Puppeteer's generic link-following ever did. Sichuan remains uncovered.

---

## Approach 2 — Standard Puppeteer (Local / Node.js)

Used purely for offline research to determine which sites are scrapeable in principle. Cannot run inside a Cloudflare Worker.

### Test setup

```
/chinese-intel-pipeline/local-scrape-test/
  package.json        (puppeteer dependency)
  scrape-test.mjs     (test script)
```

```bash
cd local-scrape-test
npm install
node scrape-test.mjs
```

### Results (tested 2026-06-25, CST)

```
Scraping Yunnan Daily...   HTTP 403 —  395 chars —  3.1s
Scraping Sichuan Daily...  HTTP 200 —  123 chars — 22.2s
Scraping Guangxi Daily...  HTTP 200 —  325 chars —  4.1s
Scraping Hunan Daily...    HTTP 200 —    7 chars — 17.2s
Scraping Fujian Daily...   HTTP 200 — 1012 chars — 23.5s
Scraping Nanfang Daily...  HTTP 200 — 1264 chars — 12.3s
Scraping Hainan Daily...   HTTP 200 —  266 chars — 10.6s
```

These results were from the original mobile/SPA URLs. After switching to static HTML portals (research documented below), the fetch engine handles 6 of 7 without any browser at all.

---

## Approach 3 — Simple fetch() + HTMLRewriter (current)

The only scraping layer. No browser dependency, no quota, runs inside the Worker.

### What works

| Source | Scraper | How | Yield |
|---|---|---|---|
| Guangxi Daily | `scrapeGuangxi()` | Epaper API → article links → individual fetch | ~8 full articles |
| Hainan Daily | `scrapeHainan()` | Node page JS `l:[…]` var → two-level content files | ~4–8 full articles |
| Hunan Daily | `scrapeHunan()` | Portal `hnrb.hunantoday.cn` → article links → fetch | ~4–6 full articles |
| Yunnan Daily | `scrapeYunnan()` | Portal `www.yndaily.com` → relative `/html/{yyyy}/…` hrefs | ~5 full articles |
| Nanfang Daily | `scrapeNanfang()` | `epaper.southcn.com` node_A01 → `epaper.nfnews.com` content links | ~6 full articles |
| Fujian Daily | `scrapeFujian()` | `fjrb.fjdaily.com/pc/col/…/node_01.html` → `../../../con/…` links | ~6 full articles |

**Total: ~33–40 full-text articles from 6 of 7 sources.**

### What does not work

| Source | Reason |
|---|---|
| Sichuan Daily | JS SPA — `fetch()` returns empty shell; page `<title>` filtered as junk by `scrapeGeneric()`; no static article URL pattern found |

### Key bugs fixed

**2026-06-27 — Yunnan Daily relative href regex**
- Old regex required full absolute URL in `href`: `href=["'](https://www.yndaily.com/html/…)["']`
- Homepage actually serves relative hrefs: `href="/html/2026/yaowenyunnan_0627/143388.html"`
- Result: 0 articles despite site being accessible. Fixed: match `/html/{yyyy}/…` and prepend base.

**2026-06-27 — Nanfang Daily**
- Both RSSHub instances fail or return stale feeds frequently.
- `epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html` is fully accessible via plain fetch.
- New dedicated `scrapeNanfang()` replaced the RSS route entirely.

**2026-06-27 — Fujian Daily**
- `scrapeGeneric()` returned just the page `<title>` ("Fujian Daily Digital Edition") because `<p>` tags aren't on the node_01 index page.
- The index page lists relative article links `../../../con/{yyyymm}/{dd}/content_*.html`.
- New dedicated `scrapeFujian()` resolves and fetches those individually.

**2026-06-27 — max_tokens context window collision**
- Bumped max_tokens to 16384 thinking it would fix truncation of last 3 articles.
- Error: 16384 output + 7617 input = 24001 tokens > 24000 token context window.
- Fix: max_tokens = 14000. Gives ~22,200 total — safe with a 1,800-token buffer.
- Root cause of "3 missing articles": those 3 were the last in the input array and likely just below the AI's relevance bar, not truncated.

**2026-06-27 — Sichuan junk article**
- `scrapeGeneric()` returned "四川日报网_四川政经新闻源 高端互动台" as an article title (the page's `<title>` tag).
- Added title filter to `scrapeGeneric()`: skip any result where title contains `网_`, `新闻源`, or is >60 chars.
- Sichuan now returns 0 articles cleanly instead of 1 junk article.

---

## Why GFW Is Not the Issue

The Great Firewall restricts outbound internet access *from within China* to foreign services. It does not restrict inbound access *to Chinese sites from abroad*. Chinese newspapers want international readers.

What we hit is each site's own WAF or anti-bot logic:
- **Yunnan Daily**: WAF with Block Event IDs — blocks datacenter IP + automated headers
- **Hunan Daily (old URL)**: client-side headless-browser detection — fixed by switching to static portal
- **Sichuan Daily**: requires app session — no network-level block

### Could Chinese proxies help?

Possibly for Yunnan Daily (WAF may whitelist domestic ranges). But:
1. Cloudflare Workers cannot configure SOCKS or HTTP CONNECT proxies — `fetch()` has no proxy API.
2. Hunan Daily's old block was client-side, so IP wouldn't help.
3. Sichuan requires a session, not an IP change.

Not implemented.

---

## Alternative URLs Found via Google Search (2026-06-25)

Switching from mobile epaper/SPA URLs to static HTML portals solved most sources:

| Source | Old URL | New URL | Result |
|---|---|---|---|
| Yunnan Daily | `yndaily.yunnan.cn/html/…` (WAF 403) | `www.yndaily.com` | 200, relative `/html/{yyyy}/…` hrefs — regex bug fixed 2026-06-27 |
| Sichuan Daily | `4g.scdaily.cn/wap/…` (123 chars SPA) | `www.scdaily.cn` | 200, but page title is website header — filtered as junk |
| Hunan Daily | `h5cgi.voc.com.cn/hnrbdzb/#/` (7 chars headless detection) | `hnrb.hunantoday.cn` | 200, static portal with article links — dedicated scraper added |
| Fujian Daily | `fjrb.fjdaily.com/pad/col/…` (mobile) | `fjrb.fjdaily.com/pc/col/…` | Both work; PC has cleaner structure |
| Nanfang Daily | `epaper.nfnews.com/m/ipaper/…#/` (SPA) | `epaper.southcn.com/nfdaily/html/…/node_A01.html` | 200, static epaper with absolute content links |
| Guangxi Daily | unchanged | unchanged | Existing API scraper still best |
| Hainan Daily | unchanged | unchanged | Existing two-level static parser still best |

---

## Jina Reader (`r.jina.ai`) — Tested as Option

Callable from a Cloudflare Worker via `fetch('https://r.jina.ai/{url}')`. Renders any URL in a real browser and returns clean markdown.

### Results (2026-06-25)

| Source | Jina result |
|---|---|
| Sichuan Daily | ✅ Full article headlines — confirmed working |
| Nanfang Daily | ⚠️ Some article titles + mostly images |
| Yunnan Daily | ❌ WAF-blocked (Jina's IPs also on blocklist) |
| Hunan Daily | ❌ Image-only epaper |

Not implemented — new static HTML URLs solved the same problems without an external dependency. Sichuan via Jina remains a viable future option.

---

## Decision Log

| Date | Decision | Reason |
|---|---|---|
| Pre-2026-06-25 | Puppeteer as primary cron strategy | Expected it to handle JS-rendered SPAs |
| 2026-06-25 | Confirmed Puppeteer free-plan cap (10 min/day) | Docs + empirical: cron always falls back to fetch |
| 2026-06-25 | Fixed Yunnan URL: `${mm}${dd}` → `${yyyymmdd}` in path segment | Bug found via local Puppeteer test |
| 2026-06-25 | Added `enrichRssArticles()` — fetch full text from RSS article URLs | RSS articles had only excerpt (~100 chars) sent to AI |
| 2026-06-25 | Two-level depth for `scrapeHainan()` | Content files in node_58471 are section pages, not articles |
| 2026-06-25 | Raised minimum article text threshold 50 → 200 chars | Section index pages were passing to AI and polluting feed |
| 2026-06-25 | Decided against Chinese residential proxies | CF Workers can't configure proxies |
| 2026-06-26 | Merged Pass 1 (title-only filter) + Pass 2 (analysis) into single combined pass | Title-only filter under-flagged articles; snippet context needed at filter stage |
| 2026-06-26 | Fixed duplicate rows on same-day re-runs | DELETE today's rows before re-inserting |
| 2026-06-27 | Fixed Yunnan regex — relative hrefs not matched | Regex required absolute URL; homepage serves `/html/2026/…` → 0 articles |
| 2026-06-27 | Replaced Nanfang RSS with dedicated `scrapeNanfang()` | Both RSSHub instances fail frequently |
| 2026-06-27 | Added dedicated `scrapeFujian()` | `scrapeGeneric` returned page title only |
| 2026-06-27 | Bumped Guangxi cap 6 → 8; snippet 200 → 250 chars; budget 8k → 10k chars | Confirmed subrequest headroom (~45/50) |
| 2026-06-27 | `limits.cpu_ms` rejected on free plan (code 100328) | Pipeline is I/O-bound; CPU limit irrelevant |
| 2026-06-27 | **Removed Puppeteer entirely** | Generic scrapeUrl() worse than dedicated scrapers; 10 min/day cap; bot-flagged by default. Fetch engine covers 6/7 sources with better quality. BROWSER binding removed from wrangler.jsonc |
| 2026-06-27 | Fixed max_tokens: 16384 → 14000 | 16384 + 7617 input = 24001 > 24000 context limit; AI rejected call, temp_articles emptied |
| 2026-06-27 | Added junk-title filter to `scrapeGeneric()` | Sichuan homepage `<title>` ("四川日报网_四川政经新闻源…") was being stored as an article |

---

## Remaining Open Problems

1. **Sichuan Daily** — JS SPA. No static article URL pattern. The only viable option is a real browser session (Jina Reader, a paid browser-render service, or upgrading CF Browser Rendering). Low priority — the other 6 sources cover the most geopolitically relevant provinces.

2. **Yunnan Daily article redirect** — `www.yndaily.com` article links appear to redirect to `yndaily.yunnan.cn` (WAF-blocked). Confirmed that portal homepage links do resolve — scraper works for now. Monitor if link structure changes.

3. **Hainan Daily node ID churn** — The node ID `58471` is assumed stable. If the site restructures section IDs, the scraper breaks silently. Future improvement: discover day's node IDs from an edition index page.
