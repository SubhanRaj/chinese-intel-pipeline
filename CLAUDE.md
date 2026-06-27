# Chinese Intel Pipeline — Claude Context

## What this project is

Automated pipeline that scrapes 7 Chinese provincial newspapers every morning (09:30 CST via cron), runs two AI passes with Llama 3.3 70B on Cloudflare Workers AI, clusters related stories, and serves structured English intelligence briefings through a Next.js dashboard with daily email dispatch.

## Architecture in one sentence

Cloudflare Worker (fetch engine scraper) → Cloudflare D1 (SQLite) → Next.js Worker (dashboard). No external servers. No browser rendering. Everything runs on Cloudflare's free/paid tiers.

## Critical constraints

- **50 subrequests/invocation (free plan)** — each `fetch()` call and AI binding call counts. D1 queries have a *separate* 50-query limit and do NOT consume the fetch subrequest budget.
- **10,000 neurons/day (Workers AI free tier)** — ~700–1,200 neurons per run, so ~8–14 runs/day. Not a real bottleneck in practice (5+ test runs used only 4.83k one day). The old cap was Puppeteer's 10 min/day browser time — that's gone.
- **Subrequest budget per run:** Yunnan(6) + Guangxi(9) + Hainan(6) + Hunan(7) + Nanfang(7) + Fujian(7) + AI×2(2) ≈ **44 total**. Don't add more fetch calls without removing others.
- **AI context window:** 24,000 tokens total. Input is ~7,600 tokens for 34 articles. max_tokens = 14,000. Total: ~21,600 — safe with ~2,400 buffer. Never set max_tokens + expected-input > 23,500.

## Two paths through the pipeline

| Trigger | Idempotency | Use |
|---|---|---|
| HTTP GET (curl) | Skips if today's `temp_articles` has data | Manual re-run / fallback |
| Cron `30 1 * * *` UTC | Skips if today's `temp_articles` OR `intel_briefings` exists | Production daily run |

Both paths use the identical fetch engine. **No Puppeteer, no Browser Rendering.**

**To force a re-run after curl/cron already ran today:** delete today's temp_articles first:
```bash
npx wrangler d1 execute intel_briefings_db --remote --command \
  "DELETE FROM temp_articles WHERE tracking_date='YYYY-MM-DD'"
```

## Pipeline resilience

- **temp_articles is cleared AFTER AI Pass 1 succeeds.** If Pass 1 fails, old feed data is preserved. Previously, temp_articles was cleared at the start — a failed AI call left the feed empty until the next run.
- **Pass 2 (cluster) failure is non-fatal.** Falls back to single-item clusters; intel_articles still saved.
- **All scrape + AI steps wrapped in try-catch** with console.error logging. Errors are surfaced as log messages, not Worker crashes.

## Two AI passes

- **Pass 1 — filter + analyse:** All scraped articles sent with title + 250-char snippet. Returns `important: true/false` + full analysis for important ones. Budget: 10,000 chars input (~40 articles). max_tokens: 14,000.
- **Pass 2 — cluster:** Important articles grouped across sources into clusters with synthesised headline. max_tokens: 2,048. Input sliced at 12,000 chars (previously 4,000 — caused clustering to silently fail when article list exceeded the cap).

Both passes use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Never downgrade to a smaller model.

## Scraping: 6 dedicated scrapers (fetch engine only)

| Source | Scraper | How it works |
|---|---|---|
| Guangxi Daily | `scrapeGuangxi()` | Epaper API (`api.php?code=&xuhao=`) → 8 articles |
| Hainan Daily | `scrapeHainan()` | Node page JS `l:[…]` var → two-level content files |
| Hunan Daily | `scrapeHunan()` | Portal `hnrb.hunantoday.cn` → same-month article links |
| Yunnan Daily | `scrapeYunnan()` | Portal `www.yndaily.com` → relative `/html/{yyyy}/…` hrefs |
| Nanfang Daily | `scrapeNanfang()` | `epaper.southcn.com/node_A01` → `epaper.nfnews.com/content_*.html` |
| Fujian Daily | `scrapeFujian()` | `fjrb.fjdaily.com/pc/col/node_01` → relative `../../../con/…` links |
| Sichuan Daily | — | JS SPA with no static article URL pattern. No coverage — 0 subrequests. |

## Database: four tiers

| Table | Content | Lifetime |
|---|---|---|
| `temp_articles` | All scraped articles (important + not), 24h feed | Cleared after next successful AI Pass 1 |
| `intel_clusters` + `intel_articles` | Important articles, fully analysed and clustered | 30 days → auto-cleanup |
| `intel_articles` where `is_preserved=1` | Hand-preserved articles | Permanent |
| `settings` | Pipeline config (email toggle) | Persistent key-value store |

**URLs are stored for ALL articles** including non-important ones in `temp_articles.url`. The dashboard shows a ↗ source link on every card.

**`settings` table keys:**
- `email_enabled`: `'0'` = off (default), `'1'` = on. Toggled from dashboard sidebar UI. No Worker redeploy needed.

## Key files

```
scraper-worker/src/index.ts    — all pipeline logic (scraping, AI, storage, email)
scraper-worker/wrangler.jsonc  — bindings (D1, AI), cron 30 1 * * * (no BROWSER binding)
dashboard/src/app/page.tsx     — server component, queries all five tables (incl. settings)
dashboard/src/components/IntelViewer.tsx — all client UI (sidebar, feed, briefing, email toggle, GitHub link)
dashboard/src/app/actions.ts   — server actions (preserve/delete article & cluster; setEmailEnabled)
dashboard/src/app/layout.tsx   — inline dark-mode script in <head> (beforeInteractive — no FOUC)
```

## Dashboard features

- **Today's Feed** — all scraped articles grouped by source newspaper, collapsed by default. Click source header to expand. AI reasoning shown for every article.
- **Intel Briefing** — clustered important articles. Multi-source stories → one card with N-sources badge and per-source drawer.
- **Archive (Preserved)** — bookmarked articles, exempt from 30-day cleanup.
- **Search** — sidebar search across all dates.
- **Dark mode** — persisted in `localStorage`. Inline `<Script strategy="beforeInteractive">` in layout.tsx adds `dark` class to `<html>` before first paint — no flash on refresh.
- **Email toggle** — on/off switch in sidebar. Writes to D1 `settings` table. Email address stays in CF secrets.
- **GitHub link** — sidebar footer.

## Things to never do

- Don't bump article fetch caps without checking total subrequest count (target ≤ 48).
- Don't add a new fetch call in the hot path without removing one elsewhere.
- Don't change the AI model to something smaller — use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Don't set `max_tokens` > (24000 − expected_input_tokens − 500). Current safe ceiling is 14,000.
- Don't add a BROWSER binding back — Puppeteer was removed 2026-06-27 intentionally.
- Don't use `dangerouslySetInnerHTML` anywhere in the dashboard.
- Don't commit `.env` or Wrangler secrets to git — stored as Wrangler secrets only.
- Don't move the temp_articles DELETE back to before the AI call — it was intentionally moved after Pass 1 to preserve feed data on AI failures.

## Deploy commands

```bash
# Scraper worker
cd scraper-worker && npm run deploy

# Dashboard
cd dashboard && npm run deploy

# Test the pipeline (skips if today's data already exists)
curl https://scraper-worker.shubhanraj2002.workers.dev

# Force re-run (delete today's feed first)
npx wrangler d1 execute intel_briefings_db --remote --command \
  "DELETE FROM temp_articles WHERE tracking_date='$(date +%Y-%m-%d)'"
curl https://scraper-worker.shubhanraj2002.workers.dev

# Check D1 data
cd scraper-worker && npx wrangler d1 execute intel_briefings_db --remote --command "SELECT ..."
```
