# Scraping Research — Chinese Provincial Press Pipeline

This document records all empirical findings, dead ends, and decisions made while figuring out how to reliably scrape the seven Chinese provincial newspapers. It exists so future work (and future debugging) doesn't have to repeat the same experiments.

---

## The Seven Sources

| # | Newspaper | Province | Base URL |
|---|-----------|----------|----------|
| 1 | Yunnan Daily (云南日报) | Yunnan | `yndaily.yunnan.cn` |
| 2 | Sichuan Daily (四川日报) | Sichuan | `4g.scdaily.cn` |
| 3 | Guangxi Daily (广西日报) | Guangxi | `ssw.gxrb.com.cn` |
| 4 | Hunan Daily (湖南日报) | Hunan | `h5cgi.voc.com.cn` |
| 5 | Fujian Daily (福建日报) | Fujian | `fjrb.fjdaily.com` |
| 6 | Nanfang Daily (南方日报) | Guangdong | `epaper.nfnews.com` |
| 7 | Hainan Daily (海南日报) | Hainan | `news.hndaily.cn` |

---

## URL Formats

These are the date-parametric entry-point URLs used by the pipeline. All dates are in CST (UTC+8).

```
Yunnan Daily:
  https://yndaily.yunnan.cn/html/{yyyy}/{yyyymmdd}/{yyyymmdd}_001/{yyyymmdd}_001_6618.html#0
  ⚠ The article ID (6618) is not stable — it was valid for 2026-06-22 but 403s for later dates.
    The path segment after the year must be yyyymmdd (full 8-digit), NOT mmdd.
    Bug found: original code used ${mm}${dd} for that segment — caused 404 for weeks.

Sichuan Daily:
  https://4g.scdaily.cn/wap/scrb/{yyyymmdd}/index.html

Guangxi Daily:
  https://ssw.gxrb.com.cn/json/interface/epaper/api.php?#p=001
  (No date in URL — the API serves today's edition by default)

Hunan Daily:
  https://h5cgi.voc.com.cn/hnrbdzb/#/
  (SPA — no date in URL; the app loads today's edition dynamically)

Fujian Daily:
  https://fjrb.fjdaily.com/pad/col/{yyyy}{mm}/{dd}/node_01.html
  Sub-sections: node_02.html, node_03.html … node_08.html

Nanfang Daily:
  https://epaper.nfnews.com/m/ipaper/nfrb/html/{yyyy}{mm}/{dd}/node_A05.html#/
  (SPA — the #/ hash signals client-side routing)

Hainan Daily:
  https://news.hndaily.cn/h5/html5/{yyyy}-{mm}/{dd}/node_58471.htm
  Sub-sections: node_58464 … node_58472 (section IDs change per day based on edition)
```

---

## Approach 1 — Cloudflare Browser Rendering (Puppeteer Fork)

### What it is

`@cloudflare/puppeteer` is a thin WebSocket client that connects to Cloudflare's hosted headless Chromium via the Browser Rendering (Browser Run) service. It is the only browser-automation option available inside a Cloudflare Worker — standard Puppeteer requires Node.js and cannot run in a V8 isolate.

### Why it consistently fails

**Free plan hard limits** (sourced from `developers.cloudflare.com/browser-rendering/platform/limits/`):

| Limit | Free Plan | Paid Plan |
|-------|-----------|-----------|
| Daily browser time | **10 minutes/day** | Unlimited (pay-as-you-go) |
| Concurrent browsers | 3 | 120 (default) |
| New browser instances | 1 per 20 seconds | 1 per second |
| Inactivity timeout | 60 seconds | 60 seconds |

Our pipeline scrapes 7 sources; each source opens an index page (`waitUntil: networkidle2`, timeout 30 s) then up to 25 sub-pages (timeout 20 s each). Worst case: 7 × (30 s + 25 × 20 s) ≈ 60 minutes. Even a modest run far exceeds the 10-minute free cap.

**Bot flag is permanent and unconditional.** The docs state: *"Requests from Browser Run will always be identified as a bot regardless of the user agent set."* Chinese newspaper sites with any anti-bot layer will reject these requests.

### Verdict

Cloudflare Browser Rendering on the free plan is **not viable** for this pipeline. Puppeteer is kept in the cron path as a best-effort attempt but the fetch engine is the real workhorse.

---

## Approach 2 — Standard Puppeteer (Local / Node.js)

### What it is

The canonical `puppeteer` npm package. Requires Node.js; spawns a local Chromium process. Cannot run inside a Cloudflare Worker. Used here purely for offline research to determine which of the 7 sites are actually scrapeable in principle.

### Test setup

```
/chinese-intel-pipeline/local-scrape-test/
  package.json        (puppeteer dependency)
  scrape-test.mjs     (test script)
```

To reproduce:

```bash
cd local-scrape-test
npm install          # installs puppeteer + downloads Chromium
node scrape-test.mjs
```

The script tries three escalating strategies for each source:
1. `waitUntil: networkidle2` — best for static pages
2. +5 s explicit wait after load — gives SPA frameworks time to hydrate
3. +scroll to bottom — triggers lazy-load listeners

It then follows up to 3 same-domain sub-links and reports body text length + a 120-char preview.

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

#### Per-source analysis

**Yunnan Daily — ❌ WAF block (403)**
- Returns 403 with a Yunnan Daily WAF error page: *"The request contains some unreasonable content and has been blocked by the site administrator settings."*
- The block includes a `Block Event ID`, confirming it is the site's own WAF, not the Great Firewall (see GFW note below).
- All three escalation strategies fail — the connection itself is blocked before JS runs.
- The article ID in the URL (`6618`) was valid for 2026-06-22 but the structure suggests it changes per edition. Dynamic discovery via the index would be needed even if the WAF were bypassed.

**Sichuan Daily — ❌ SPA, no content (123 chars)**
- Returns HTTP 200 with a tiny shell (`<div id="app"></div>` equivalent — just 123 chars).
- 5-second explicit wait + scroll do not change the body text at all.
- The app likely loads content from an API that requires a session cookie or app-specific token not available to a headless browser.
- RSSHub has no confirmed route for Sichuan Daily (`/scdaily`, `/sichuan/daily` both return 503).

**Guangxi Daily — ✅ Accessible (325 chars + API)**
- The fetch-based dedicated API scraper (`ssw.gxrb.com.cn/json/interface/epaper/api.php?`) works well without a browser.
- Puppeteer adds nothing here. The static epaper API returns proper HTML with `<area>` map tags listing all article links.
- Yields ~19 full-text articles per run.

**Hunan Daily — ❌ Headless detection (7 chars) at old SPA URL — ✅ fixed via portal URL**
- The original SPA (`h5cgi.voc.com.cn/hnrbdzb/`) returns 7 chars — client-side headless detection.
- `hnrb.hunantoday.cn` (the main portal) is fully static: article links follow `/{yyyy}{mm}/TIMESTAMP.html` pattern.
- Dedicated `scrapeHunan()` fetches the portal index, extracts same-month article links, fetches each individually. Full body text, no RSS needed. Yields ~4–6 articles per run.

**Fujian Daily — ✅ Accessible (1012 chars) — dedicated scraper added 2026-06-27**
- Static HTML. Section node pages (`node_01.html` through `node_08.html`) load article headline lists.
- Sub-links are labelled sections: `(01) 要闻`, `(02) 要闻`, `(03) 经济`, `(04) 社会`, `(05) 文化/科技`, `(06) 时事`, `(07) 海峡`, `(08) 深读`.
- Article links are relative: `../../../con/{yyyymm}/{dd}/content_XXXXXX.html` → resolves to `https://fjrb.fjdaily.com/pc/con/…`.
- Individual article pages have full Chinese body text in `<p>` tags — no JS required. Yields ~6 articles from node_01.

**Nanfang Daily — ✅ Static epaper accessible — dedicated scraper added 2026-06-27**
- `epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html` is static HTML listing absolute `epaper.nfnews.com/nfdaily/html/{yyyymm}/{dd}/content_XXXXXXXX.html` article links.
- Each content page has full article body text. Yields ~6-7 articles per run.
- Previous approach (RSSHub) was unreliable — both instances frequently returned 503 or empty feeds.
- Note: index is on `southcn.com` but content links are on `nfnews.com` (same publisher, two domains).

**Hainan Daily — ⚠️ Navigation only (266 chars)**
- Returns HTTP 200; body contains section navigation HTML but not article body text.
- Puppeteer sub-links are the section node pages (e.g. `node_58464.htm` = 头版, `node_58465.htm` = 本省新闻).
- The fetch-based `scrapeHainan()` function is *better* than Puppeteer here: it parses the inline JS `l:[...]` array in each node page to get `content_XXXXX.htm` article files, then fetches those directly.
- After the two-level depth fix (2026-06-25), the scraper now drills through section pages to find actual article content files if the first level returns < 200 chars.

---

## Approach 3 — Simple fetch() + HTMLRewriter

The current primary strategy for the pipeline. No browser dependency, no quota, runs inside the Worker.

### What works

| Source | Method | Yield |
|--------|--------|-------|
| Guangxi Daily | Dedicated epaper API scraper | ~8 full articles |
| Hainan Daily | Two-level `l:[...]` static parser | ~4–8 full articles |
| Hunan Daily | Dedicated portal scraper (`hnrb.hunantoday.cn`) | ~4–6 full articles |
| Yunnan Daily | Dedicated portal scraper (`www.yndaily.com`) — relative href fix | ~5 full articles |
| Nanfang Daily | Dedicated static epaper scraper (`epaper.southcn.com` → `epaper.nfnews.com`) | ~6 full articles |
| Fujian Daily | Dedicated static epaper scraper (`fjrb.fjdaily.com/pc/col/…/node_01.html`) | ~6 full articles |

**Total fetch-engine yield: ~33–40 full-text articles** from 6 of 7 sources.

### What does not work

| Source | Reason |
|--------|--------|
| Sichuan Daily | JS SPA — `fetch()` returns empty shell; no static article URL pattern; no RSS route found |

### Key bugs fixed (2026-06-27)

**Yunnan Daily — relative href regex bug**
- Old regex required full absolute URL in `href`: `href=["'](https://www.yndaily.com/html/…)["']`
- Homepage actually serves relative hrefs: `href="/html/2026/yaowenyunnan_0627/143388.html"`
- Result: 0 articles scraped despite the site being accessible. Fixed by matching `/html/{yyyy}/…` and prepending `https://www.yndaily.com`.

**Nanfang Daily — RSS was the bottleneck, not the site**
- Both RSSHub instances (`rsshub.rssforever.com`, `rsshub.app`) frequently fail or return stale feeds.
- `epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html` is fully accessible via plain fetch and lists absolute `epaper.nfnews.com/…/content_*.html` article links.
- New dedicated `scrapeNanfang()` replaces the RSS route entirely with static HTML scraping.

**Fujian Daily — scrapeGeneric was wrong tool**
- `scrapeGeneric()` fetches the node_01.html page and runs HTMLRewriter, returning just the page `<title>` ("Fujian Daily Digital Edition") because the `<p>` tags with real content aren't on the index page.
- The index page lists relative article links (`../../../con/{yyyymm}/{dd}/content_*.html`) which resolve to `https://fjrb.fjdaily.com/pc/con/…`.
- New dedicated `scrapeFujian()` extracts and resolves those links, fetches each article individually.

---

## Why GFW Is Not the Issue

A common first guess is that the Great Firewall of China blocks access to these sites from abroad. **This is incorrect.** The GFW restricts outbound internet access *from within China* to foreign services (Google, Wikipedia, etc.). It does not restrict inbound access *to Chinese sites from abroad* — Chinese newspapers want international readers.

What we are hitting is each site's own **WAF (Web Application Firewall)** or **anti-bot logic**:
- **Yunnan Daily**: explicit WAF with Block Event IDs. Blocks by traffic pattern (datacenter IP + automated headers), not by geography.
- **Hunan Daily**: client-side headless-browser detection. Works fine in a real browser with any IP.
- **Sichuan Daily**: requires an app session — no network-level block.

### Could Chinese proxies help?

Possibly for Yunnan Daily, whose WAF may whitelist domestic IP ranges. However:
1. Cloudflare Workers cannot use SOCKS or HTTP CONNECT proxies — the `fetch()` API has no proxy configuration. You would need a separate proxy gateway HTTP endpoint, adding cost and a new failure point.
2. Hunan Daily's block is client-side, so a Chinese IP would not help.
3. Sichuan Daily requires a session, not an IP change.

**Not worth implementing** given the low coverage gain.

---

## Decision Log

| Date | Decision | Reason |
|------|----------|--------|
| Pre-2026-06-25 | Puppeteer as primary cron strategy | Expected it to handle JS-rendered SPAs |
| 2026-06-25 | Confirmed Puppeteer free-plan cap (10 min/day) | Docs + empirical: cron always falls back to fetch |
| 2026-06-25 | Fixed Yunnan URL: `${mm}${dd}` → `${yyyymmdd}` in path | Bug found via local Puppeteer test; article ID `6618` was also found to be edition-specific |
| 2026-06-25 | Added `enrichRssArticles()` — fetch full text from RSS article URLs | RSS articles previously had only excerpt (~100 chars) sent to AI Pass 2, producing thin analysis |
| 2026-06-25 | Two-level depth for `scrapeHainan()` — drill through section pages | Content files in node_58471 are section pages, not articles; need one more level |
| 2026-06-25 | Raised minimum article text threshold 50 → 200 chars | Section index pages (nav + headlines only) were passing to AI filter and polluting Today's Feed |
| 2026-06-25 | Decided against Chinese residential proxies | CF Workers can't configure proxies; Hunan/Sichuan wouldn't benefit |
| 2026-06-26 | Merged Pass 1 (title-only filter) + Pass 2 (analysis) into single combined pass | Title-only filter under-flagged articles (13 vs 2); snippet context needed at filter stage |
| 2026-06-26 | Fixed duplicate rows on same-day re-runs | DELETE today's rows before re-inserting; cron + curl on same day was stacking 85 rows for 17 URLs |
| 2026-06-27 | Fixed Yunnan regex — relative hrefs not matched | Regex required full absolute URL; homepage serves `/html/2026/…` relative hrefs → 0 articles |
| 2026-06-27 | Replaced Nanfang RSS with dedicated `scrapeNanfang()` | Both RSSHub instances fail frequently; static `epaper.southcn.com` works perfectly via fetch |
| 2026-06-27 | Added dedicated `scrapeFujian()` | `scrapeGeneric` returned page title only; node_01.html has `content_*.html` article links |
| 2026-06-27 | Bumped Guangxi cap 6 → 8 articles; AI snippet 200 → 250 chars; budget 8k → 10k chars | Confirmed subrequest headroom (~46/50); D1 queries have separate limit (50/invocation) |
| 2026-06-27 | `limits.cpu_ms` not supported on free plan | Tried adding 30 s CPU limit; CF API rejected it (code 100328). Not needed — pipeline is I/O-bound |

---

## What "sir" did with Claude Browsing

The original prompt that inspired the pipeline was submitted to Claude's web-browsing tool (likely Claude's computer use or a Claude agent with browser access):

```
Scan provincial daily newspapers of these 7 links.
Check page by page all news headings.
Provide analysis of important news headlines for the day …
```

Claude's browsing capability uses a real, non-headless browser running under Anthropic's infrastructure. It:
- Is not flagged as a bot by Chinese WAFs (non-datacenter IP, real browser fingerprint)
- Can execute SPA JavaScript normally (Hunan, Sichuan, Nanfang)
- Uses the date-specific URLs that were valid that day (June 22 article ID `6618` happened to be correct)

This is fundamentally not replicable in a Cloudflare Worker. It confirms the sites *can* be scraped with a sufficiently capable browser — but not with any automated tool we can run in our current infrastructure for free.

---

## Alternative URLs Found via Google Search (2026-06-25)

Searching each newspaper name on Google revealed significantly better entry points than the original mobile epaper URLs. All tested with `curl` and our `extractText` simulator.

| Source | Old URL | New URL | Result |
|--------|---------|---------|--------|
| Yunnan Daily | `yndaily.yunnan.cn/html/…` (WAF 403) | `www.yndaily.com` | 200, relative `/html/{yyyy}/…` article hrefs — **regex bug fixed 2026-06-27** (was matching absolute URLs only → 0 articles) |
| Sichuan Daily | `4g.scdaily.cn/wap/…` (123 chars, SPA) | `www.scdaily.cn` | **200, 106 semantic text blocks** — generic scraper works perfectly |
| Hunan Daily | `h5cgi.voc.com.cn/hnrbdzb/#/` (7 chars, headless detection) | `hnrb.hunantoday.cn` | **200, static HTML portal with direct article links** — dedicated scraper added |
| Fujian Daily | `fjrb.fjdaily.com/pad/col/…` (mobile) | `fjrb.fjdaily.com/pc/col/…` | Both work; PC has cleaner structure |
| Nanfang Daily | `epaper.nfnews.com/m/ipaper/…#/` (SPA shell) | `epaper.southcn.com/nfdaily/html/…/node_A01.html` | **200, static epaper with article headlines in `<p>` tags** |
| Guangxi Daily | unchanged | unchanged | Existing API scraper still best |
| Hainan Daily | unchanged | unchanged | Existing two-level static parser still best |

### Hunan Daily — Dedicated Scraper Added

`hnrb.hunantoday.cn` is a static HTML portal that lists article links with the pattern:
```
https://hnrb.hunantoday.cn/article/{yyyymm}/{yyyymmddHHMMSSxxxxxxxxx}.html
```

Each article page returns ~2,500 chars of body text in `<p>` tags, fully extractable by our `HTMLRewriter` pipeline. The dedicated `scrapeHunan()` function:
1. Fetches the index page
2. Regex-matches article links for the current month (`/article/yyyymm/`)
3. Fetches each article, extracts text, filters at 200 chars minimum
4. Yields up to 20 full articles

This replaces both the old SPA URL and the RSS fallback for Hunan Daily entirely.

### Sichuan Daily — URL Update Only

`www.scdaily.cn` homepage has 106 semantic text blocks (article titles + excerpts) in `<h>` and `<p>` tags, directly readable by the generic `extractText` scraper. No code changes needed — just updated the URL in `buildSources`.

### Nanfang Daily — URL Update + RSS Retained

`epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html` is a static epaper page with article headlines per section. Sub-pages follow the pattern `node_A02.html`, `node_A03.html` etc. The generic scraper now hits this instead of the SPA. RSS via RSSHub is kept as a supplement since the static epaper gives headlines only (no full article body).

## Jina Reader (`r.jina.ai`) — Tested as Tier 3 Option

Jina Reader is a free HTTP API that renders any URL in a real browser and returns clean markdown. Callable directly from a Cloudflare Worker via `fetch('https://r.jina.ai/{url}')`. No API key needed for basic use (20 RPM); free key gives 500 RPM.

### Test results (2026-06-25)

| Source | Jina result |
|--------|-------------|
| Sichuan Daily | ✅ Full article headlines across 6 pages — confirmed working before URL fix |
| Nanfang Daily | ⚠️ Some article titles + mostly images |
| Yunnan Daily | ❌ Still WAF-blocked (Jina's IPs also on blocklist) |
| Hunan Daily | ❌ Image-only epaper — content is scanned newspaper pages, not text |

Jina was not implemented in the worker since the new static HTML URLs solved Sichuan and Hunan without it. Kept as a documented option for future problem sources.

### PDF / OCR epaper question

Some Chinese epapers offer PDF downloads of the daily print edition. However:
- **All tested epapers are image PDFs** — scanned newspaper pages, not text-layer PDFs
- **Cloudflare Workers cannot run PDF parsers or OCR** — no native PDF.js, no Tesseract
- **OCR via external API** (e.g. Google Vision, Azure OCR) would add cost and latency, and Chinese newspaper fonts are a known OCR challenge
- Storing the PDF download URL in `temp_articles` for manual reading is feasible but adds no intelligence value to the pipeline

Not implemented. The static HTML portals discovered above provide better text coverage than OCR of image PDFs would.

## Remaining Open Problems

1. **Yunnan Daily** — `www.yndaily.com` is not WAF-blocked but article links all redirect to `yndaily.yunnan.cn` (WAF-blocked). The main portal is a link aggregator; actual article pages live on the blocked domain. No workaround found without a Chinese residential proxy or alternative domain.

2. **Fujian Daily full articles** — The PC/mobile epaper scraper gets section headline lists (~1,000 chars covering all headlines on a section page), not individual article bodies. An article-level scraper would require mapping from section pages to individual article URLs.

3. **Hainan Daily node ID churn** — The node ID `58471` and content file IDs change per edition. The current scraper assumes this is the daily section entry. If the site restructures, the scraper breaks silently. A future improvement: discover the day's node IDs by fetching the edition index.

4. **Nanfang Daily article depth** — `epaper.southcn.com` gives headline titles but not article bodies. Individual article pages would need a further scraping layer.

---

## Local Test Reproduction

```bash
# Prerequisites: Node.js 18+
cd chinese-intel-pipeline/local-scrape-test
npm install
node scrape-test.mjs
```

Output: per-source HTTP status, body length (chars), article previews, scrapeable/partial/blocked summary.

The script uses the same date logic as the Worker (CST = UTC+8) and the same 7 URLs. Re-run it on any date to check current site accessibility. It does not touch the Cloudflare Worker or D1 database.
