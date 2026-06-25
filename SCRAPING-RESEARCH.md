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

**Hunan Daily — ❌ Headless detection (7 chars)**
- Returns HTTP 200 but body is literally 7 characters after networkidle2, 5-second wait, and scroll.
- The app detects headless mode and renders nothing. This is not a network block — it is client-side detection.
- Real browser (e.g., Chrome with DevTools closed, or Claude's web browsing tool) can access this fine.
- RSS via RSSHub (`/hnrb`) is the only reliable automated route. After our `enrichRssArticles` fix, the pipeline also attempts to fetch each article's source URL for full text.

**Fujian Daily — ✅ Accessible (1012 chars)**
- Static HTML. Section node pages (`node_01.html` through `node_08.html`) load article headline lists.
- Sub-links are labelled sections: `(01) 要闻`, `(02) 要闻`, `(03) 经济`, `(04) 社会`, `(05) 文化/科技`, `(06) 时事`, `(07) 海峡`, `(08) 深读`.
- Important: the generic HTMLRewriter fetch scraper is actually sufficient here — no Puppeteer needed.
- Preview from page 01: `"福建日报 (01) 要闻 … 同心同德 兴民兴邦 以扎实举措推进农业农村现代化 用勤劳和智慧创造更加"` — genuine article content.

**Nanfang Daily — ⚠️ SPA shell (1264 chars after JS wait)**
- Returns HTTP 200; after a 5-second explicit wait the body grows from ~0 to 1264 chars.
- Content is the SPA navigation shell plus some article metadata — not full article body text.
- RSSHub (`/southcn/nfapp/column/38`) provides title + excerpt reliably. `enrichRssArticles` fetches full text from each article URL on a best-effort basis.

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
| Guangxi Daily | Dedicated epaper API scraper | ~19 full articles |
| Hainan Daily | Two-level `l:[...]` static parser | ~14 full articles |
| Fujian Daily | Generic HTMLRewriter | 1 combined article (section headlines) |
| Hunan Daily | RSS (RSSHub `/hnrb`) + URL enrichment | ~15 articles; tries full fetch |
| Nanfang Daily | RSS (RSSHub `/southcn/nfapp/column/38`) + URL enrichment | ~10 articles; tries full fetch |

### What does not work

| Source | Reason |
|--------|--------|
| Yunnan Daily | WAF 403 on all non-browser requests from non-whitelisted IPs |
| Sichuan Daily | SPA with no static fallback; no RSS route found |

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

## Remaining Open Problems

1. **Yunnan Daily** — Needs dynamic article ID discovery (the ID in the URL changes per edition) AND a way past the WAF. One approach: try fetching the edition index page (`/{yyyy}/{yyyymmdd}/`) to discover the day's article links. Still blocked by WAF from datacenter IPs.

2. **Sichuan Daily** — No RSS feed found. Options: find an alternative URL pattern, find a third-party aggregator, or drop this source until a workaround is found.

3. **Fujian Daily full articles** — The generic HTMLRewriter scraper gets section headline lists, not individual article bodies. An article-level scraper (similar to Guangxi/Hainan) would require reverse-engineering their URL structure.

4. **Hainan article ID churn** — The node ID `58471` and content file IDs change per edition. The current scraper assumes `node_58471` is the daily deep-read section. If the site restructures, the scraper breaks silently.

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
