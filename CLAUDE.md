# Chinese Intel Pipeline — Claude Context

## What this project is

Automated pipeline that scrapes 7 Chinese provincial newspapers every morning (09:30 CST via cron), runs two AI passes with Llama 3.3 70B on Cloudflare Workers AI, clusters related stories, and serves structured English intelligence briefings through a Next.js dashboard with daily email dispatch.

## Architecture in one sentence

Cloudflare Worker (scraper) → Cloudflare D1 (SQLite) → Next.js Worker (dashboard). No external servers. Everything runs on Cloudflare's free/paid tiers.

## Critical constraints

- **50 subrequests/invocation (free plan)** — each `fetch()` call, AI binding call counts. D1 queries have a *separate* 50-query limit and do NOT consume the fetch subrequest budget.
- **10,000 neurons/day (Workers AI free tier)** — current usage ~1,100–1,300 neurons per run (Pass 1 ~930, Pass 2 ~245). Safe for ~7 runs/day.
- **Browser Rendering: 10 min/day (free)** — Puppeteer is cron-only and best-effort. The fetch engine is the real workhorse.
- **Subrequest budget per run (current):** Yunnan(6) + Guangxi(9) + Hainan(9) + Hunan(7) + Nanfang(7) + Fujian(7) + Sichuan(1) + AI×2(2) ≈ **48 total**. Don't add more fetch calls without removing others.

## Two paths through the pipeline

| Trigger | Puppeteer | Idempotency | Use |
|---|---|---|---|
| HTTP GET (curl) | Never | Skipped — always runs | Manual testing / re-runs |
| Cron `30 1 * * *` UTC | Yes, primary | Enforced — once per CST date | Production daily run |

The idempotency check looks for an existing `intel_briefings` row for today's CST date. If a curl run happens after 16:00 UTC (= midnight CST), it creates a June+1 record that will block the cron. This is a known footgun.

## Two AI passes

- **Pass 1 — filter + analyse:** All scraped articles sent with title + 250-char snippet. Returns `important: true/false` + full analysis for important ones. Budget: 10,000 chars input (~40 articles).
- **Pass 2 — cluster:** Important articles grouped across sources into clusters with synthesised headline.

Both passes use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Never downgrade to a smaller model — quality matters for geopolitical analysis.

## Scraping: 6 dedicated scrapers + 1 generic

| Source | Scraper | How it works |
|---|---|---|
| Guangxi Daily | `scrapeGuangxi()` | Epaper API (`api.php?code=&xuhao=`) → 8 articles |
| Hainan Daily | `scrapeHainan()` | Node page JS `l:[…]` var → two-level content files |
| Hunan Daily | `scrapeHunan()` | Portal `hnrb.hunantoday.cn` → same-month article links |
| Yunnan Daily | `scrapeYunnan()` | Portal `www.yndaily.com` → relative `/html/{yyyy}/…` hrefs |
| Nanfang Daily | `scrapeNanfang()` | `epaper.southcn.com/node_A01` → `epaper.nfnews.com/content_*.html` |
| Fujian Daily | `scrapeFujian()` | `fjrb.fjdaily.com/pc/col/node_01` → relative `../../../con/…` links |
| Sichuan Daily | `scrapeGeneric()` | JS SPA — returns empty; Puppeteer covers it on cron |

RSS infrastructure (`scrapeRss`, `parseRssXml`, `RSS_CONFIGS`) is kept but `RSS_CONFIGS = []` — all sources now have static scrapers.

## Database: three tiers

| Table | Content | Lifetime |
|---|---|---|
| `temp_articles` | All scraped articles (important + not), 24h feed | Deleted at next run start |
| `intel_clusters` + `intel_articles` | Important articles, fully analysed and clustered | 30 days → auto-cleanup |
| `intel_articles` where `is_preserved=1` | Hand-preserved articles | Permanent |

**URLs are stored for ALL articles** including non-important ones in `temp_articles.url`. The dashboard shows a ↗ source link on every card, including grey `—` (not important) ones — users can read the original Chinese article themselves.

## Key files

```
scraper-worker/src/index.ts   — all pipeline logic (scraping, AI, storage, email)
scraper-worker/wrangler.jsonc — bindings (D1, BROWSER, AI), cron, limits.cpu_ms=30000
dashboard/src/app/page.tsx    — server component, DB queries
dashboard/src/components/IntelViewer.tsx — all client UI
dashboard/src/app/actions.ts  — server actions (preserve/delete)
```

## Things to never do

- Don't bump article fetch caps without checking total subrequest count (target ≤ 48).
- Don't add a new fetch call in the hot path without removing one elsewhere.
- Don't change the AI model to something smaller — use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Don't use `dangerouslySetInnerHTML` anywhere in the dashboard.
- Don't commit `.env` or Wrangler secrets to git — they are stored as Wrangler secrets only.

## Deploy commands

```bash
# Scraper worker
cd scraper-worker && npm run deploy

# Dashboard
cd dashboard && npm run deploy

# Test the fetch engine (no Puppeteer quota used)
curl https://scraper-worker.shubhanraj2002.workers.dev

# Check D1 data
cd scraper-worker && npx wrangler d1 execute intel_briefings_db --remote --command "SELECT ..."
```
