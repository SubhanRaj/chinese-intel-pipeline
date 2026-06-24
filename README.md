# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes Chinese provincial newspapers every morning, analyses and translates the content with Cloudflare Workers AI (Llama 3.3 70B), clusters same-topic stories from multiple sources, and serves structured English briefings through an interactive Next.js dashboard with daily email dispatch.

## Architecture

```
   curl / browser ──────────────────────────────────► fetch handler
                                                        │ fetch engine only
                                                        │ (Puppeteer never invoked)
                                                        │ idempotency skipped
                                                        │
   cron 30 1 * * * ──────────────────────────────────► scheduled handler
                                                        │ Puppeteer first
                                                        │ → fetch fallback on failure
                                                        │ idempotency enforced
                                                        │
                                            ┌───────────▼──────────────────────┐
                                            │         SCRAPING LAYER            │
                                            │                                   │
                                            │  Tier 1 — Puppeteer (cron only)   │
                                            │  Full headless Chromium · 7 srcs  │
                                            │  → on 429 / crash → Tier 2       │
                                            │                                   │
                                            │  Tier 2 — Fetch Engine            │
                                            │  ├─ Guangxi: epaper API scraper   │
                                            │  ├─ Hainan:  static HTML parser   │
                                            │  └─ Others:  HTMLRewriter generic │
                                            └───────────┬──────────────────────┘
                                                        │  ScrapedArticle[]
                                                        │  (~33 articles via fetch)
                                            ┌───────────▼──────────────────────┐
                                            │     AI PASS 1 — FILTER            │
                                            │                                   │
                                            │  Llama 3.3 70B                    │
                                            │  Input: all titles only (~4k tok) │
                                            │  Output per article:              │
                                            │    title_en, important, reason    │
                                            └───────────┬──────────────────────┘
                                                        │
                                          ┌─────────────┴──────────────┐
                                          │                            │
                                   ALL articles               Important subset
                                  → temp_articles               (~8–12 articles)
                                  (24h feed view)                      │
                                                        ┌─────────────▼────────────┐
                                                        │   AI PASS 2 — ANALYSE     │
                                                        │                           │
                                                        │  Llama 3.3 70B            │
                                                        │  Input: full text (~12k)  │
                                                        │  Output per article:      │
                                                        │    title_en, summary,     │
                                                        │    full_text_en, category │
                                                        └─────────────┬────────────┘
                                                                      │  AiArticle[]
                                                        ┌─────────────▼────────────┐
                                                        │   AI PASS 3 — CLUSTER     │
                                                        │                           │
                                                        │  Llama 3.3 70B            │
                                                        │  Groups same-topic        │
                                                        │  articles across sources  │
                                                        │  Output: intel_clusters   │
                                                        │  with synthesised title + │
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

HTTP handler and cron handler are hardcoded to different paths in the Worker source — no URL parameters are involved.

| Trigger | How | Puppeteer | Idempotency | Use for |
|---|---|---|---|---|
| `curl https://scraper-worker…` | HTTP GET | Never — fetch engine only | Skipped — always executes | Manual testing |
| Cron `30 1 * * *` | Cloudflare scheduler | Yes, primary path | Enforced — once per CST date | Production daily run |

This means curl triggers never consume Browser Rendering quota. Puppeteer runs only on the automatic scheduled job.

---

## Scraping strategy

### Tier 1 — Puppeteer (cron only)

Full headless Chromium via Cloudflare Browser Rendering. Navigates each source's index page, collects up to 25 sub-page links, fetches each as a separate article. Images, stylesheets, and fonts are aborted at the request interceptor. Covers all 7 sources when available. Falls back to Tier 2 automatically on any failure (429, crash, quota exhaustion).

### Tier 2 — Fetch Engine (HTTP trigger + cron fallback)

Native `fetch()` + `HTMLRewriter` — no npm dependency, no browser, no quota.

#### What the fetch engine can scrape

| Source | Strategy | Detail |
|---|---|---|
| **Guangxi Daily** | Dedicated API scraper ✅ | Fetches the epaper index (`ssw.gxrb.com.cn/json/interface/epaper/api.php?`), extracts article links from inline `<area>` map tags (`code` + `xuhao` params), fetches each article individually. Skips editor credits (`责任编辑`, `客户端`, `版责`, `广西云`). Yields **~19 articles** per run. |
| **Hainan Daily** | Static HTML parser ✅ | Fetches the node page (`node_58471.htm`), parses inline JS `var map_NODE = { l: ["content_*.htm"] }` to get article file list, fetches each file. Yields **~14 articles** per run. |
| **Yunnan Daily** | Generic HTMLRewriter ❌ | Returns HTTP 403 — server blocks non-browser requests regardless of UA spoofing. Puppeteer only. |
| **Sichuan Daily** | Generic HTMLRewriter ❌ | JS-rendered SPA — `fetch()` receives a shell with `<noscript>` content only. Puppeteer only. |
| **Hunan Daily** | Generic HTMLRewriter ❌ | Vue SPA — same issue as Sichuan. Puppeteer only. |
| **Fujian Daily** | Generic HTMLRewriter ❌ | JS-rendered — returns ~22 chars of usable text. Puppeteer only. |
| **Nanfang Daily** | Generic HTMLRewriter ❌ | JS-rendered SPA — returns 0 usable chars. Puppeteer only. |

When only the fetch engine runs (HTTP trigger or Puppeteer failure), Guangxi + Hainan provide **~33 real articles** — sufficient for daily briefings. The 5 remaining sources are covered by tomorrow's cron.

#### Text extraction

`HTMLRewriter` selects only semantic content tags: `h1`, `h2`, `h3`, `h4`, `p`. Blocked before extraction: `script`, `style`, `nav`, `header`, `footer`, `aside`, `noscript`. Whitespace is collapsed. No HTML attributes, class names, CSS, or structural markup reaches the AI.

---

## Three-pass AI pipeline

**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Cloudflare Workers AI — free tier)

Three sequential AI calls per run. Each pass is cheap relative to doing everything in one shot.

### Pass 1 — Filter

All scraped article titles sent to Llama. The model evaluates every article for geopolitical significance and returns a structured decision for each.

**Output per article:**
```json
{ "index": 0, "title_en": "English title", "important": true, "reason": "One sentence explanation" }
```

**Marked important** (aim ~20–30% of articles): military movements/procurement/doctrine, senior national or provincial leadership decisions, bilateral diplomacy and cross-border events, economic policy with international implications, technology with strategic or dual-use potential, significant unrest or politically sensitive events.

**Marked not important:** local infrastructure, sports/entertainment/tourism, routine agriculture/weather/education, advertising, administrative notices, provincial economic statistics with no international angle, party study campaigns, purely domestic trade fairs or signing ceremonies.

The reason for both included and excluded articles is stored in `temp_articles` and shown in the Today's Feed dashboard view — so you can audit and improve the filter criteria over time.

**Token budget:**
| Item | Value |
|---|---|
| Input (all titles) | ~33 titles × ~50 chars × 2 tok/char ≈ 3,300 tokens |
| Output (decisions + reasons) | ~33 entries × ~80 chars ≈ 1,300 tokens |
| Total | ~4,600 tokens |

### Pass 2 — Deep analysis

Runs only on the important subset (~8–12 articles). Full translation, geopolitical summary, category.

| Limit | Value | Why |
|---|---|---|
| Per-article text | 400 chars | ~800 tokens; fewer articles means more budget per article |
| Total JSON input | 5,800 chars budget | Articles added one-by-one until budget exhausted — no mid-JSON truncation |
| `max_tokens` output | 4,096 | Default 256 truncates JSON arrays |
| Model context window | 24,000 tokens | System ~500 + input ~12k + output ~4k ≈ 16,500 — safe |

**Output per article:**
```json
{
  "title": "English headline",
  "summary": "2–3 sentence geopolitical analysis. [HIGH] if significant.",
  "full_text_en": "Complete faithful English translation",
  "url": "original source URL unchanged",
  "category": "Political | Military | Economic | Technology | Social | Foreign Affairs"
}
```

### Pass 3 — Cluster

Groups same-topic articles from different newspapers into clusters. When Guangxi Daily and Hainan Daily both cover the same story (e.g. a Xi Jinping speech), they are merged into one cluster with a synthesised headline and combined assessment.

**Output per cluster:**
```json
{
  "title": "Synthesised headline drawing on all sources' angles",
  "summary": "2–3 sentence synthesis. Notes framing differences between papers if present.",
  "category": "Political | ...",
  "article_indices": [0, 2]
}
```

Standalone unique articles form single-element clusters (`"article_indices": [3]`). Every article appears in exactly one cluster.

### Response format handling

Workers AI returns two envelope shapes depending on whether `max_tokens` is set:

| Condition | Shape | Key |
|---|---|---|
| Default (no `max_tokens`) | `{ response: string }` | `response.response` |
| With `max_tokens` | OpenAI-compat `{ choices: [...] }` | `choices[0].message.content` |

All three passes handle both shapes via a shared `extractAiText()` helper. The model is Llama in all cases.

If any pass fails to produce a parseable JSON array, a hard fallback fires: Pass 1 treats all articles as important; Pass 2 saves articles with `summary: 'Analysis unavailable.'`; Pass 3 treats each article as its own cluster. No data is ever lost.

---

## Three-tier article storage

| Tier | Table | Content | Duration | AI work |
|---|---|---|---|---|
| **Feed** | `temp_articles` | All scraped articles, title + importance reason | ~24h — deleted at next morning run | Pass 1 only |
| **Briefing** | `intel_articles` + `intel_clusters` | Important articles, fully analysed and clustered | 30 days → auto-cleanup | Pass 1 + 2 + 3 |
| **Preserved** | `intel_articles` (`is_preserved=1`) | Hand-preserved articles | Permanent | Pass 1 + 2 + 3 |

`temp_articles` is purged at the start of each pipeline run before inserting today's articles, so the feed reflects the current day only.

---

## Dashboard views

### Today's Feed
All ~33 scraped articles grouped by source newspaper. Each article shows:
- **✓ green** — AI flagged as important; went to full analysis; appears in Intel Briefing
- **— grey** — AI skipped; title translated only; original source link still available
- One-sentence AI reasoning for every decision (included and excluded alike)

Useful for auditing filter quality and improving importance criteria over time.

### Intel Briefing
One card per cluster (not per article). When multiple newspapers covered the same story, one card appears with a violet **N sources** badge.

**Cluster card:** synthesised headline, combined assessment, category badge, [HIGH] badge if flagged, source newspaper tags. Preserve/Delete operates on all articles in the cluster.

**Cluster drawer (slide-in panel):**
- Combined intelligence assessment at the top
- "Publisher Perspectives" section — one sub-card per source newspaper, each showing:
  - That paper's own translated title and summary
  - Full English translation
  - 中文 toggle to read the original Chinese source text
  - Link to original source URL
  - Option to remove one perspective from the cluster

### Archive (Preserved)
Articles preserved via the bookmark button. Exempt from 30-day cleanup. Shown as individual article cards since preserved articles span multiple dates where cluster context no longer applies.

### Search
**Sidebar search** — filters the sidebar itself: Preserved articles, Today's Feed section, and Briefing entries all hide when they don't match the query. Clicking a result carries the search term into the main view's search box.

**Main view search** — live client-side filter across title, summary, and source. Available in Briefing and Archive views.

---

## Email

Daily briefings dispatched via **Resend** using a compact table-based HTML template (inline CSS throughout — required for Gmail compatibility):

- `<table>` layout — Gmail strips `<style>` blocks so all CSS must be inline
- `max-width: 580px` + `width: 100%` + `16px` side padding — readable on mobile Gmail without horizontal scrolling
- Each story row: category tag + **HIGH** red pill badge (when applicable) → headline → 2–3 sentence summary only
- **No article body text in email** — summary only
- "View in Dashboard →" per story links to the dashboard, not the Chinese source
- "Open Full Briefing" red button in footer
- Subject: `China Intel Briefing — YYYY-MM-DD`
- Email contains cluster-level entries (one per story, not one per article)

Email is **disabled by default** (`ENABLE_EMAIL` must be set to `"true"` as a Worker secret).

---

## Sources

| Paper | Province | Fetch engine | Puppeteer |
|---|---|---|---|
| Guangxi Daily | Guangxi | ✅ ~19 articles via epaper API | ✅ |
| Hainan Daily | Hainan | ✅ ~14 articles via static HTML | ✅ |
| Yunnan Daily | Yunnan | ❌ 403 Forbidden | ✅ |
| Sichuan Daily | Sichuan | ❌ JS-rendered SPA | ✅ |
| Hunan Daily | Hunan | ❌ Vue SPA | ✅ |
| Fujian Daily | Fujian | ❌ JS-rendered | ✅ |
| Nanfang Daily | Guangdong | ❌ JS-rendered SPA | ✅ |

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
| `is_important` | INTEGER | 0 = skipped by filter, 1 = sent to Pass 2 |
| `importance_reason` | TEXT | One-sentence AI explanation for the decision |
| `cluster_id` | INTEGER | FK → intel_clusters; set after Pass 3 for important articles |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_clusters` — one row per story cluster

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | YYYY-MM-DD, CST |
| `title` | TEXT | Synthesised English headline (Pass 3) |
| `summary` | TEXT | Combined multi-source assessment (Pass 3) |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `sources` | TEXT | JSON array of source names e.g. `["Guangxi Daily","Hainan Daily"]` |
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
| `cluster_id` | INTEGER | FK → intel_clusters (null for legacy articles) |
| `title` | TEXT | English translation (Pass 2) |
| `summary` | TEXT | 2–3 sentence geopolitical analysis |
| `full_text` | TEXT | Original Chinese body text |
| `full_text_en` | TEXT | Complete English translation |
| `url` | TEXT | Source article URL |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `source` | TEXT | Paper name |
| `is_preserved` | INTEGER | 0 = normal, 1 = exempt from 30-day cleanup |
| `created_at` | TEXT | `datetime('now')` default |

---

## Dashboard features

| Feature | Detail |
|---|---|
| **Cluster cards** | One card per story — synthesised headline, combined summary, multi-source badge, category + HIGH indicators |
| **Publisher perspectives drawer** | Slide-in panel showing each source's own title, summary, full translation, 中文 source toggle, and per-article preserve |
| **Today's Feed** | All scraped articles grouped by source, ✓/— badges with AI reasoning for each filter decision; important articles show "View Full Analysis" button opening the cluster drawer directly |
| **Preserve / Delete** | Cluster-level (all articles in cluster) with per-article override in drawer; preserved articles exempt from cleanup |
| **Archive** | Dedicated view of all preserved articles across all dates |
| **Sidebar search** | Filters sidebar entries (Preserved, Today's Feed, Briefings) by title or date in real time; clicking a result carries the query into the main search view |
| **Global search view** | Typing in the search bar (or activating via sidebar) opens a dedicated results page showing matching clusters across **all briefing dates** — not just the selected one; clearing the query returns to the previous view |
| **Print Briefing** | `window.print()` with sidebar hidden |
| **Dark / light mode** | Toggle in sidebar header; high-contrast light mode with WCAG AA compliant text colours; preference persists via `localStorage` across sessions |
| **State persistence** | Active view (Feed / Briefing / Preserved), selected briefing date, and sidebar open state restored on refresh via `sessionStorage` |
| **PWA** | Installable via `manifest.json`; theme matches red brand accent |
| **Mobile responsive** | Sidebar collapses with hamburger; drawer goes full-width; touch-friendly tap targets |
| **Backward-compat** | Old articles without `cluster_id` are wrapped as virtual single-item clusters so legacy briefings render correctly |

---

## Security

| Surface | Protection |
|---|---|
| Server Actions | Input validated server-side; `deleteArticle` re-checks `is_preserved = 0` before deletion; `unpreserveAndDelete` is atomic; batch cluster actions validate every ID |
| URL rendering | All `href` values pass through `safeUrl()` — only `http://` and `https://` allowed |
| Content rendering | Article text rendered as React text nodes, never `dangerouslySetInnerHTML` |
| No upload endpoints | Worker accepts no file uploads, form posts, or arbitrary payloads — only preserve/delete server actions |
| Trigger hardening | HTTP trigger is hardcoded to fetch-only in Worker source — no URL parameter can activate Puppeteer or alter pipeline behaviour |
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
│   │   │   ├── fetchHtml()              fetch wrapper with UA + Referer
│   │   │   ├── extractText()            HTMLRewriter — h1–h4/p only; blocks script/style/nav/header/footer/aside/noscript
│   │   │   ├── scrapeGuangxi()          Epaper API scraper — index → article links → individual fetch
│   │   │   ├── scrapeHainan()           Static HTML parser — node page JS var → content files → fetch
│   │   │   ├── scrapeGeneric()          HTMLRewriter fallback — returns [] for JS-rendered pages
│   │   │   ├── fetchAndParseSources()   Orchestrates all fetch scrapers in parallel
│   │   │   ├── scrapeUrl()              Puppeteer per-source scraper (cron path only)
│   │   │   ├── extractAiText()          Shared helper — handles both Workers AI response envelopes
│   │   │   ├── extractJsonArray()       Shared helper — finds best JSON array in raw AI text
│   │   │   ├── filterArticlesWithAI()   Pass 1 — filter by title, returns importance + reason per article
│   │   │   ├── analyseWithWorkersAI()   Pass 2 — deep analysis on important subset only
│   │   │   ├── clusterArticlesWithAI()  Pass 3 — group same-topic articles across sources
│   │   │   ├── sendEmail()              Resend + table-layout HTML template (mobile Gmail safe)
│   │   │   └── runPipeline()            Main orchestrator; fetch() passes fetchOnly=true, scheduled() passes false
│   │   └── db/schema.ts                 Drizzle ORM schema (intelBriefings, intelArticles, intelClusters, tempArticles)
│   └── wrangler.jsonc                   AI, BROWSER, D1 bindings; cron 30 1 * * *
└── dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── actions.ts               Server Actions: togglePreserve, deleteArticle, unpreserveAndDelete,
    │   │   │                                            togglePreserveCluster, deleteCluster
    │   │   ├── layout.tsx               Metadata, fonts
    │   │   ├── page.tsx                 Server component — queries briefings, articles, clusters, feed
    │   │   └── globals.css              Tailwind v4 + Shadcn tokens
    │   ├── components/
    │   │   ├── IntelViewer.tsx          Client: sidebar, Today's Feed, ClusterCard, ClusterDrawer,
    │   │   │                                    ArticleCard (preserved view), ArticleDrawer, search, dark toggle
    │   │   ├── MarkdownRenderer.tsx     Legacy briefings (react-markdown, ssr:false)
    │   │   └── ui/                      Shadcn primitives
    │   └── db/schema.ts                 Drizzle ORM (mirrors scraper-worker)
    └── wrangler.jsonc                   Worker-mode deploy
```

---

## Setup & deployment

### Prerequisites
- Cloudflare account with Workers, D1, Browser Rendering, Workers AI enabled
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

### 4. Test the fetch engine (no Browser Rendering quota used)

```bash
curl https://scraper-worker.shubhanraj2002.workers.dev
```

Runs the full three-pass pipeline via fetch engine only (Guangxi + Hainan, ~33 articles). The dashboard will show Today's Feed, Intel Briefing clusters, and send an email if `ENABLE_EMAIL=true`. The first cron run at 01:30 UTC will execute the Puppeteer path across all 7 sources.

**Re-running curl after a deploy:** safe to do — curl bypasses idempotency so it always executes a fresh scrape and AI run regardless of whether today's date already has data. Existing briefing/cluster rows for that date are upserted (overwritten), not duplicated. Re-run whenever you deploy scraper changes and want to validate the new AI behaviour immediately without waiting for the next cron.

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
| Scraper — primary | Cloudflare Workers + `@cloudflare/puppeteer` (Browser Rendering) — cron only |
| Scraper — fetch engine | Native `fetch()` + `HTMLRewriter` (built into Workers runtime) |
| AI Pass 1 — filter | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — title-only filtering (~4.6k tokens) |
| AI Pass 2 — analysis | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — deep analysis on important subset |
| AI Pass 3 — clustering | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — cross-source story grouping |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email | Resend API — table-layout HTML template (mobile Gmail compatible) |
| Dashboard | Next.js 16 App Router via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + Shadcn UI |
| Fonts | DM Serif Display + Inter + Geist Mono via `next/font/google` |
| Icons | Tabler Icons |
