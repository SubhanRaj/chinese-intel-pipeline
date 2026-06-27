# Chinese Intel Pipeline — Claude Context

## What this project is

Automated pipeline that scrapes 7 Chinese provincial newspapers every morning (09:30 CST via cron), runs two AI passes with Llama 3.3 70B on Cloudflare Workers AI, clusters related stories, and serves structured English intelligence briefings through a Next.js dashboard with daily email dispatch.

## Architecture in one sentence

Cloudflare Worker (fetch engine scraper) → Cloudflare D1 (SQLite) → Next.js Worker (dashboard). No external servers. No browser rendering. Everything runs on Cloudflare's free/paid tiers.

## Critical constraints

- **50 subrequests/invocation (free plan)** — each `fetch()` call and AI binding call counts. D1 queries have a *separate* 50-query limit and do NOT consume the fetch subrequest budget.
- **10,000 neurons/day (Workers AI free tier)** — current usage ~700–1,200 neurons per run. Safe for ~8–14 runs/day.
- **Subrequest budget per run:** Yunnan(6) + Guangxi(9) + Hainan(6) + Hunan(7) + Nanfang(7) + Fujian(7) + Sichuan(1) + AI×2(2) ≈ **45 total**. Don't add more fetch calls without removing others.
- **AI context window:** 24,000 tokens total. Input is ~7,600 tokens for 34 articles. max_tokens = 14,000. Total: ~21,600 — safe with ~2,400 buffer. Never set max_tokens + expected-input > 23,500.

## Two paths through the pipeline

| Trigger | Idempotency | Use |
|---|---|---|
| HTTP GET (curl) | Skipped — always re-runs | Manual testing / re-runs |
| Cron `30 1 * * *` UTC | Enforced — once per CST date | Production daily run |

Both paths use the identical fetch engine. **No Puppeteer, no Browser Rendering.** The idempotency check looks for an existing `intel_briefings` row for today's CST date. If a curl run happens after 16:00 UTC (= midnight CST), it creates a next-day record that will block the cron. This is a known footgun.

**temp_articles is cleared at the START of each run** before the AI call. If the AI call fails (e.g. context limit exceeded), temp_articles will be empty until the next successful run. This means Today's Feed disappears on failed runs.

## Two AI passes

- **Pass 1 — filter + analyse:** All scraped articles sent with title + 250-char snippet. Returns `important: true/false` + full analysis for important ones. Budget: 10,000 chars input (~40 articles). max_tokens: 14,000.
- **Pass 2 — cluster:** Important articles grouped across sources into clusters with synthesised headline. max_tokens: 2,048.

Both passes use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Never downgrade to a smaller model.

## Scraping: 6 dedicated scrapers + 1 generic (fetch engine only)

**Puppeteer was removed 2026-06-27.** The generic scrapeUrl() function was worse than dedicated scrapers and the 10 min/day free cap made it unusable.

| Source | Scraper | How it works |
|---|---|---|
| Guangxi Daily | `scrapeGuangxi()` | Epaper API (`api.php?code=&xuhao=`) → 8 articles |
| Hainan Daily | `scrapeHainan()` | Node page JS `l:[…]` var → two-level content files |
| Hunan Daily | `scrapeHunan()` | Portal `hnrb.hunantoday.cn` → same-month article links |
| Yunnan Daily | `scrapeYunnan()` | Portal `www.yndaily.com` → relative `/html/{yyyy}/…` hrefs |
| Nanfang Daily | `scrapeNanfang()` | `epaper.southcn.com/node_A01` → `epaper.nfnews.com/content_*.html` |
| Fujian Daily | `scrapeFujian()` | `fjrb.fjdaily.com/pc/col/node_01` → relative `../../../con/…` links |
| Sichuan Daily | `scrapeGeneric()` | JS SPA — `scrapeGeneric()` filters the junk page-title; returns empty |

RSS infrastructure (`scrapeRss`, `parseRssXml`, `RSS_CONFIGS`) is kept but `RSS_CONFIGS = []` — all sources now have static scrapers.

## Database: three tiers

| Table | Content | Lifetime |
|---|---|---|
| `temp_articles` | All scraped articles (important + not), 24h feed | Deleted at next run START (before AI call) |
| `intel_clusters` + `intel_articles` | Important articles, fully analysed and clustered | 30 days → auto-cleanup |
| `intel_articles` where `is_preserved=1` | Hand-preserved articles | Permanent |

**URLs are stored for ALL articles** including non-important ones in `temp_articles.url`. The dashboard shows a ↗ source link on every card.

## Key files

```
scraper-worker/src/index.ts    — all pipeline logic (scraping, AI, storage, email)
scraper-worker/wrangler.jsonc  — bindings (D1, AI), cron 30 1 * * * (no BROWSER binding)
dashboard/src/app/page.tsx     — server component, DB queries
dashboard/src/components/IntelViewer.tsx — all client UI
dashboard/src/app/actions.ts   — server actions (preserve/delete)
dashboard/public/theme-init.js — dark mode FOUC fix (runs before first paint)
```

## Things to never do

- Don't bump article fetch caps without checking total subrequest count (target ≤ 48).
- Don't add a new fetch call in the hot path without removing one elsewhere.
- Don't change the AI model to something smaller — use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Don't set `max_tokens` > (24000 − expected_input_tokens − 500). Current safe ceiling is 14,000.
- Don't add a BROWSER binding back — Puppeteer was removed intentionally.
- Don't use `dangerouslySetInnerHTML` anywhere in the dashboard.
- Don't commit `.env` or Wrangler secrets to git — they are stored as Wrangler secrets only.

## Deploy commands

```bash
# Scraper worker
cd scraper-worker && npm run deploy

# Dashboard
cd dashboard && npm run deploy

# Test the pipeline (bypasses idempotency — always re-runs)
curl https://scraper-worker.shubhanraj2002.workers.dev

# Check D1 data
cd scraper-worker && npx wrangler d1 execute intel_briefings_db --remote --command "SELECT ..."
```
