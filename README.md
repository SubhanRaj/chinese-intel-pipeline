# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes Chinese provincial newspapers every morning, analyses and translates content with Cloudflare Workers AI (Llama 3.3 70B), clusters same-topic stories across sources, and serves structured English briefings through an interactive Next.js dashboard with daily email dispatch.

## Architecture

```
   curl / browser ──────────────────────────────────► fetch handler
                                                        │ always re-runs (no idempotency)
                                                        │
   cron 30 1 * * * ──────────────────────────────────► scheduled handler
                                                        │ idempotency: skip if today exists
                                                        │
                                            ┌───────────▼──────────────────────┐
                                            │       FETCH ENGINE (only tier)    │
                                            │                                   │
                                            │  6 dedicated scrapers (parallel)  │
                                            │  ├─ scrapeGuangxi()  epaper API   │
                                            │  ├─ scrapeHainan()   2-level HTML │
                                            │  ├─ scrapeHunan()    portal HTML  │
                                            │  ├─ scrapeYunnan()   portal HTML  │
                                            │  ├─ scrapeNanfang()  static epapr │
                                            │  └─ scrapeFujian()   static epapr │
                                            │  + scrapeGeneric() for Sichuan    │
                                            │    (returns [] — JS SPA)          │
                                            └───────────┬──────────────────────┘
                                                        │  ScrapedArticle[]
                                                        │  (~33–40 full-text articles)
                                            ┌───────────▼──────────────────────┐
                                            │   AI PASS 1 — FILTER + ANALYSE    │
                                            │                                   │
                                            │  Llama 3.3 70B (fp8-fast)         │
                                            │  Input: title + 250-char snippet  │
                                            │  Budget: 10,000 chars (~40 arts)  │
                                            │  max_tokens: 14,000               │
                                            │  Total context: ~7.6k + 14k       │
                                            │    = ~21.6k / 24k limit — safe    │
                                            │                                   │
                                            │  Output per article:              │
                                            │    title_en, important, reason    │
                                            │    summary, full_text_en, category│
                                            │    (summary/translation only for  │
                                            │     important articles)           │
                                            └───────────┬──────────────────────┘
                                                        │
                                          ┌─────────────┴──────────────┐
                                          │                            │
                                   ALL articles               Important subset
                                  → temp_articles               (~13–20 articles)
                                  (24h feed view)                      │
                                                        ┌─────────────▼────────────┐
                                                        │   AI PASS 2 — CLUSTER     │
                                                        │                           │
                                                        │  Llama 3.3 70B            │
                                                        │  Groups same-topic        │
                                                        │  articles across sources  │
                                                        │  Output: intel_clusters   │
                                                        │  synthesised title +      │
                                                        │  combined summary         │
                                                        └─────────────┬────────────┘
                                                                      │
                                            ┌─────────────────────────▼────────────┐
                                            │        STORAGE + DISPATCH LAYER       │
                                            │                                       │
                                            │  intel_clusters upsert                │
                                            │  intel_articles upsert (w/ cluster_id)│
                                            │  intel_briefings parent record        │
                                            │  30-day cleanup (unpreserved)         │
                                            │  Resend email (table-layout template) │
                                            └─────────────────────────┬────────────┘
                                                                      │
                                                         Cloudflare D1 (SQLite)
                                                                      │
                                            ┌─────────────────────────▼────────────┐
                                            │              DASHBOARD                │
                                            │  Next.js 16 · Cloudflare Worker       │
                                            │                                       │
                                            │  Today's Feed  — all articles, 24h    │
                                            │  Intel Briefing — clusters, 30 days   │
                                            │  Archive        — preserved, forever  │
                                            └──────────────────────────────────────┘
```

**Cron schedule:** `30 1 * * *` UTC = **09:30 CST** — after morning editions publish.

---

## Trigger modes

| Trigger | How | Idempotency | Use for |
|---|---|---|---|
| `curl https://scraper-worker…` | HTTP GET | **Skipped** — always re-runs | Manual refresh, testing |
| Cron `30 1 * * *` | Cloudflare scheduler | **Enforced** — once per CST date | Production daily run |

Both paths use the identical fetch engine. No Puppeteer, no Browser Rendering quota.

---

## Fetch Engine — the only scraping layer

Native `fetch()` + `HTMLRewriter` built into the Workers runtime. No npm dependency, no browser, no quota. Six sources have purpose-built dedicated scrapers; Sichuan (JS SPA) falls through the generic scraper with empty output.

### What the fetch engine scrapes

| Source | Scraper | How it works | Yield |
|---|---|---|---|
| **Guangxi Daily** | `scrapeGuangxi()` | Fetches epaper index (`ssw.gxrb.com.cn/json/interface/epaper/api.php?`), extracts article links via `href="?name=gxrb&date=…&code=…&xuhao=…"` pattern, fetches each article | **~8 articles/run** |
| **Hainan Daily** | `scrapeHainan()` | Fetches node page, parses inline JS `l:[…]` array for content file list, fetches each. Two-level: short-text files are section pages → drills one level deeper | **~4–8 articles/run** |
| **Hunan Daily** | `scrapeHunan()` | Fetches `hnrb.hunantoday.cn`, extracts article links matching `/{yyyy}{mm}/` path prefix, fetches each individually. Full body text | **~4–6 articles/run** |
| **Yunnan Daily** | `scrapeYunnan()` | Fetches `www.yndaily.com`, extracts relative `/html/{yyyy}/…` hrefs (absolute-URL regex bug fixed 2026-06-27), fetches each | **~5 articles/run** |
| **Nanfang Daily** | `scrapeNanfang()` | Fetches `epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html`, extracts absolute `epaper.nfnews.com/…/content_*.html` links, fetches each | **~6 articles/run** |
| **Fujian Daily** | `scrapeFujian()` | Fetches `fjrb.fjdaily.com/pc/col/{yyyymm}/{dd}/node_01.html`, resolves relative `../../../con/{yyyymm}/{dd}/content_*.html` links, fetches each | **~6 articles/run** |
| **Sichuan Daily** | `scrapeGeneric()` | JS-rendered SPA — fetch returns a shell; `scrapeGeneric` also filters any article whose page `<title>` looks like a website header (`网_`, `新闻源`, or >60 chars). Returns empty. | **0 articles** |

**Total fetch-engine yield: ~33–40 full-text articles from 6 of 7 sources per run.**

Sichuan Daily is the only gap. It requires a real browser session. Adding a separate Sichuan endpoint is the main remaining improvement opportunity.

### Text extraction

`HTMLRewriter` selects only semantic content tags: `h1`, `h2`, `h3`, `h4`, `p`. Blocked: `script`, `style`, `nav`, `header`, `footer`, `aside`, `noscript`. Whitespace is collapsed. No HTML attributes, class names, or markup reach the AI.

### Subrequest budget

Each `fetch()` call counts against the 50 subrequests/invocation free-plan limit. D1 queries have a **separate** 50-query limit and do NOT consume the fetch budget.

| Source | Fetch calls |
|---|---|
| Yunnan | 1 (index) + 5 (articles) = 6 |
| Guangxi | 1 (index) + 8 (articles) = 9 |
| Hainan | 1 (node) + up to 5 (content) = 6 |
| Hunan | 1 (index) + 6 (articles) = 7 |
| Nanfang | 1 (index) + 6 (articles) = 7 |
| Fujian | 1 (index) + 6 (articles) = 7 |
| Sichuan | 1 (returns empty) = 1 |
| AI Pass 1 | 1 |
| AI Pass 2 | 1 |
| **Total** | **~45 / 50** |

### RSS scraper (inactive)

The `scrapeRss()` infrastructure is kept (tries `rsshub.rssforever.com` then `rsshub.app`, 8 s timeout, parses RSS 2.0 and Atom) but `RSS_CONFIGS` is currently empty — all sources now have working dedicated fetch scrapers. Remains available if a source loses its static URL.

---

## Two-pass AI pipeline

**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Cloudflare Workers AI — free tier)
**Neuron budget:** ~10,000 neurons/day free. Each run uses ~700–1,200 neurons. Safe for ~8–14 runs/day.

### Pass 1 — Combined filter + analyse

All scraped articles sent with title + 250-character body snippet. The model judges importance from actual content and produces full analysis in the same call.

**Input per article:**
```json
{ "index": 0, "title": "Chinese title", "snippet": "First 250 chars of body text" }
```

**Output per article:**
```json
{
  "index": 0,
  "title_en": "English headline",
  "important": true,
  "reason": "One sentence explaining why included or excluded",
  "summary": "2–3 sentence geopolitical analysis. [HIGH] if significant.",
  "full_text_en": "Faithful English translation of the snippet",
  "category": "Political | Military | Economic | Technology | Social | Foreign Affairs"
}
```

For `important: false` articles, `summary`, `full_text_en`, and `category` are empty — only `title_en` and `reason` are populated. These are stored in `temp_articles` so you can audit filter decisions in Today's Feed.

**Token budget:**

| Item | Value |
|---|---|
| Input per article | title (~20 tokens) + snippet (~180 tokens) ≈ 200 tokens |
| Total input (34 articles) | ~7,600 tokens |
| System prompt | ~600 tokens |
| `max_tokens` output | 14,000 |
| Total context used | ~22,200 / 24,000 limit — safe with ~1,800 token buffer |

**Important:** input token count is in Chinese characters which tokenise ~1:1 in Llama 3.3. Keeping the 10,000-char input budget ensures input stays below ~8,000 tokens, leaving 16,000 for output (capped at 14,000 for safety).

### Pass 2 — Cluster

Groups same-topic articles from different newspapers. Each cluster has a synthesised headline and combined assessment.

**Output:**
```json
{
  "title": "Synthesised headline drawing on all sources' angles",
  "summary": "2–3 sentence synthesis.",
  "category": "Political | ...",
  "article_indices": [0, 2]
}
```

Standalone articles form single-element clusters. Every article appears in exactly one cluster.

### Response format handling

Workers AI returns two envelope shapes depending on whether `max_tokens` is set:

| Condition | Shape |
|---|---|
| Default (no `max_tokens`) | `{ response: string }` |
| With `max_tokens` | OpenAI-compat `{ choices: [{ message: { content: string } }] }` |

Both shapes handled by `extractAiText()`. If a pass fails to parse valid JSON, a fallback fires: Pass 1 treats all articles as important with stub analysis; Pass 2 treats each article as its own cluster.

---

## Three-tier article storage

| Tier | Table | Content | Duration |
|---|---|---|---|
| **Feed** | `temp_articles` | All scraped articles — title + importance reason (both important and not) | ~24h — cleared at next run |
| **Briefing** | `intel_articles` + `intel_clusters` | Important articles, fully analysed and clustered | 30 days → auto-cleanup |
| **Preserved** | `intel_articles` (`is_preserved=1`) | Hand-preserved articles | Permanent |

`temp_articles` is purged at the start of each pipeline run (BEFORE AI call) and re-inserted after. If the AI call fails, temp_articles is empty until the next successful run.

---

## Dashboard views

### Today's Feed
All ~33–40 scraped articles grouped by source newspaper:
- **✓ green** — AI flagged as important; full analysis; appears in Intel Briefing
- **— grey** — AI skipped; title translated only; source URL still available
- One-sentence AI reasoning for every decision

### Intel Briefing
One card per cluster. Multiple articles from different papers → one card with "N sources" badge. Cluster drawer shows each source's own translated title, summary, English translation, 中文 toggle, and source URL.

### Archive (Preserved)
Articles preserved via the bookmark button. Exempt from 30-day cleanup.

### Search
Sidebar search filters nav live. Enter/Search commits query and opens a results page across all dates. Clears back to previous view.

---

## Email

Daily briefings via **Resend**. Table-based HTML template (inline CSS — required for Gmail). One row per cluster. Subject: `China Intel Briefing — YYYY-MM-DD`. Disabled by default (`ENABLE_EMAIL` secret must be `"true"`).

---

## Sources

| Paper | Province | Fetch engine |
|---|---|---|
| Guangxi Daily | Guangxi | ✅ ~8 articles — epaper API (`ssw.gxrb.com.cn`) |
| Hainan Daily | Hainan | ✅ ~4–8 articles — two-level static HTML parser |
| Hunan Daily | Hunan | ✅ ~4–6 articles — portal (`hnrb.hunantoday.cn`) |
| Yunnan Daily | Yunnan | ✅ ~5 articles — portal (`www.yndaily.com`) |
| Nanfang Daily | Guangdong | ✅ ~6 articles — static epaper (`epaper.southcn.com`) |
| Fujian Daily | Fujian | ✅ ~6 articles — static epaper (`fjrb.fjdaily.com`) |
| Sichuan Daily | Sichuan | ❌ JS SPA — fetch returns empty shell; no browser available |

---

## Database schema

### `temp_articles` — all scraped articles, 24h lifespan

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | YYYY-MM-DD, CST |
| `title` | TEXT | Original Chinese title |
| `title_en` | TEXT | AI translation (Pass 1) |
| `full_text` | TEXT | Raw extracted body text |
| `url` | TEXT | Source article URL |
| `source` | TEXT | Paper name |
| `is_important` | INTEGER | 0 = filtered out, 1 = important |
| `importance_reason` | TEXT | One-sentence AI explanation |
| `cluster_id` | INTEGER | FK → intel_clusters; backfilled after Pass 2 for important articles |
| `parse_type` | TEXT | `'full'` = complete body; `'rss'` = RSS excerpt only |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_clusters` — one row per story cluster

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | YYYY-MM-DD, CST |
| `title` | TEXT | Synthesised English headline |
| `summary` | TEXT | Combined multi-source assessment |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `sources` | TEXT | JSON array of source names |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_briefings` — daily parent record

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT UNIQUE | YYYY-MM-DD, CST |
| `raw_scraped_text` | TEXT | Concatenated source text |
| `ai_analysis_markdown` | TEXT | `'articles'` sentinel for new runs; legacy Markdown for old ones |
| `email_status` | INTEGER | 0 = not sent, 1 = sent |

### `intel_articles` — per-article rows

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | FK → intel_briefings |
| `cluster_id` | INTEGER | FK → intel_clusters |
| `title` | TEXT | English translation (Pass 1) |
| `summary` | TEXT | 2–3 sentence geopolitical analysis |
| `full_text` | TEXT | Original Chinese body text |
| `full_text_en` | TEXT | English translation |
| `url` | TEXT | Source article URL |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `source` | TEXT | Paper name |
| `is_preserved` | INTEGER | 0 = normal, 1 = exempt from 30-day cleanup |
| `parse_type` | TEXT | `'full'` = complete body; `'rss'` = RSS excerpt only |
| `created_at` | TEXT | `datetime('now')` default |

---

## Security

| Surface | Protection |
|---|---|
| Server Actions | Input validated server-side; `deleteArticle` re-checks `is_preserved = 0`; batch cluster actions validate every ID |
| URL rendering | All `href` values pass through `safeUrl()` — only `http://` and `https://` allowed |
| Content rendering | Article text rendered as React text nodes, never `dangerouslySetInnerHTML` |
| Secrets | `RESEND_API_KEY`, `RESEND_TO_EMAIL`, `RESEND_FROM_EMAIL`, `ENABLE_EMAIL` stored as Wrangler secrets — never in source or git |

---

## Project layout

```
chinese-intel-pipeline/
├── scraper-worker/
│   ├── migrations/
│   │   ├── 0001_add_articles_table.sql
│   │   ├── 0002_add_full_text_en.sql
│   │   ├── 0003_add_category_source.sql
│   │   ├── 0004_add_temp_articles.sql
│   │   ├── 0005_add_clusters.sql
│   │   └── 0006_temp_articles_cluster_id.sql
│   ├── src/
│   │   ├── index.ts                     # All pipeline logic
│   │   │   ├── fetchHtml()              fetch wrapper with UA + Referer headers
│   │   │   ├── extractText()            HTMLRewriter — h1–h4/p only; blocks nav/header/footer/script/style
│   │   │   ├── scrapeGuangxi()          Epaper API → article links → individual fetch (~8 articles)
│   │   │   ├── scrapeHainan()           Node page JS var → two-level content files → fetch (~4–8)
│   │   │   ├── scrapeHunan()            Portal (hnrb.hunantoday.cn) article links → fetch (~4–6)
│   │   │   ├── scrapeYunnan()           Portal (www.yndaily.com) relative hrefs → fetch (~5)
│   │   │   ├── scrapeNanfang()          Static epaper node_A01 → nfnews.com content links → fetch (~6)
│   │   │   ├── scrapeFujian()           Static epaper node_01 → relative content links → fetch (~6)
│   │   │   ├── scrapeGeneric()          HTMLRewriter fallback — Sichuan; filters junk page-title articles
│   │   │   ├── fetchAndParseSources()   Orchestrates all 6 dedicated scrapers + Sichuan generic in parallel
│   │   │   ├── parseRssXml()            RSS 2.0 / Atom parser (RSS_CONFIGS empty — infrastructure only)
│   │   │   ├── scrapeRss()              RSSHub fetcher with 8 s timeout (inactive)
│   │   │   ├── extractAiText()          Handles both Workers AI response envelopes
│   │   │   ├── extractJsonArray()       Finds best JSON array in raw AI text
│   │   │   ├── filterAndAnalyseWithAI() Pass 1 — combined filter + analysis (title + 250-char snippet)
│   │   │   ├── clusterArticlesWithAI()  Pass 2 — cross-source story grouping
│   │   │   ├── sendEmail()              Resend + table-layout HTML (mobile Gmail safe)
│   │   │   └── runPipeline()            Orchestrator; isCron=true enforces idempotency
│   │   └── db/schema.ts                 Drizzle ORM schema
│   └── wrangler.jsonc                   AI + D1 bindings; cron 30 1 * * *
└── dashboard/
    ├── public/
    │   └── theme-init.js                Blocking dark-mode script (before first paint — no FOUC)
    ├── src/
    │   ├── app/
    │   │   ├── actions.ts               Server Actions: preserve/delete cluster + article
    │   │   ├── layout.tsx               Metadata, fonts, theme-init script
    │   │   ├── page.tsx                 Server component — queries all four tables
    │   │   └── globals.css              Tailwind v4 + Shadcn tokens
    │   ├── components/
    │   │   ├── IntelViewer.tsx          Client: sidebar, Today's Feed, ClusterCard, ClusterDrawer,
    │   │   │                                    ArticleCard (preserved), search, dark toggle
    │   │   ├── MarkdownRenderer.tsx     Legacy briefings (react-markdown, ssr:false)
    │   │   └── ui/                      Shadcn primitives
    │   └── db/schema.ts                 Drizzle ORM (mirrors scraper-worker)
    └── wrangler.jsonc                   Worker-mode deploy
```

---

## Setup & deployment

### Prerequisites
- Cloudflare account with Workers, D1, Workers AI enabled
- `npx wrangler login`

### 1. Create D1 database and apply migrations

```bash
npx wrangler d1 create intel_briefings_db
cd scraper-worker
npx wrangler d1 migrations apply intel_briefings_db --remote
```

### 2. Set Worker secrets

```bash
cd scraper-worker
npx wrangler secret put ENABLE_EMAIL      # "true" to activate email dispatch
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_TO_EMAIL
npx wrangler secret put RESEND_FROM_EMAIL
```

### 3. Deploy

```bash
cd scraper-worker && npm run deploy
cd ../dashboard && npm run deploy
```

### 4. Test (manual trigger)

```bash
curl https://scraper-worker.shubhanraj2002.workers.dev
```

Runs the full two-pass pipeline immediately. The dashboard will show Today's Feed and Intel Briefing clusters. The daily cron at 01:30 UTC runs automatically via Cloudflare scheduler.

**Re-running curl:** always safe — curl bypasses idempotency and re-scrapes + re-analyses regardless of whether today's data exists. Existing rows for that date are upserted (not duplicated).

---

## Production URLs

| Service | URL |
|---|---|
| Dashboard | `https://dashboard.shubhanraj2002.workers.dev` |
| Worker (HTTP trigger) | `https://scraper-worker.shubhanraj2002.workers.dev` |

---

## Tech stack

| Layer | Technology |
|---|---|
| Scraper | Native `fetch()` + `HTMLRewriter` (built into Workers runtime) — no browser, no npm dependency |
| AI Pass 1 — filter + analyse | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — combined filter + analysis using title + 250-char snippet |
| AI Pass 2 — clustering | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — cross-source story grouping |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email | Resend API — table-layout HTML template (mobile Gmail compatible) |
| Dashboard | Next.js 16 App Router via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + Shadcn UI |
| Fonts | DM Serif Display + Inter + Geist Mono via `next/font/google` |
| Icons | Tabler Icons |
