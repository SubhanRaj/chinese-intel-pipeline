# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes Chinese provincial newspapers every morning, analyses and translates the content with Cloudflare Workers AI (Llama 3.3 70B), clusters same-topic stories from multiple sources, and serves structured English briefings through an interactive Next.js dashboard with daily email dispatch. Sources that block direct fetch are covered by a three-tier strategy: Puppeteer (cron), dedicated fetch scrapers, and RSS feeds via RSSHub for partial coverage.

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
                                            │  ├─ Others:  HTMLRewriter generic │
                                            │  │   (returns [] for JS SPAs)     │
                                            │  └─ RSS (RSSHub fallback)         │
                                            │     ├─ Hunan:   /hnrb             │
                                            │     └─ Nanfang: /southcn/...      │
                                            │        title + excerpt only       │
                                            │        parse_type = 'rss'         │
                                            └───────────┬──────────────────────┘
                                                        │  ScrapedArticle[]
                                                        │  (~33 full + RSS excerpts)
                                            ┌───────────▼──────────────────────┐
                                            │   AI PASS 1 — FILTER + ANALYSE    │
                                            │                                   │
                                            │  Llama 3.3 70B                    │
                                            │  Input: title + 200-char snippet  │
                                            │  (~8k chars, ~30 articles)        │
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

Native `fetch()` + `HTMLRewriter` — no npm dependency, no browser, no quota. Runs in parallel: dedicated scrapers for Guangxi and Hainan, generic HTMLRewriter for the remaining three (Yunnan, Sichuan, Fujian — all return `[]` due to JS rendering or 403), and RSS scrapers for Hunan and Nanfang.

#### What the fetch engine can scrape

| Source | Strategy | Detail |
|---|---|---|
| **Guangxi Daily** | Dedicated API scraper ✅ | Fetches the epaper index (`ssw.gxrb.com.cn/json/interface/epaper/api.php?`), extracts article links from inline `<area>` map tags (`code` + `xuhao` params), fetches each article individually. Skips editor credits (`责任编辑`, `客户端`, `版责`, `广西云`). Yields **~19 articles** per run. |
| **Hainan Daily** | Static HTML parser ✅ | Fetches the node page (`node_58471.htm`), parses inline JS `var map_NODE = { l: ["content_*.htm"] }` to get article file list, fetches each file. Yields **~14 articles** per run. |
| **Hunan Daily** | RSS (RSSHub `/hnrb`) ✅ | Title + RSS excerpt only — no full body text. Stored with `parse_type = 'rss'`. Dashboard shows amber **RSS** badge and prominent source link. |
| **Nanfang Daily** | RSS (RSSHub `/southcn/nfapp/column/38`) ✅ | Title + RSS excerpt only. Same RSS treatment as Hunan Daily. |
| **Yunnan Daily** | Generic HTMLRewriter ❌ | Returns HTTP 403 — server blocks non-browser requests regardless of UA spoofing. Puppeteer only. |
| **Sichuan Daily** | Generic HTMLRewriter ❌ | JS-rendered SPA — `fetch()` receives a shell with `<noscript>` content only. Puppeteer only. |
| **Fujian Daily** | Generic HTMLRewriter ❌ | JS-rendered — returns ~22 chars of usable text. Puppeteer only. |

When only the fetch engine runs (HTTP trigger or Puppeteer failure), Guangxi + Hainan provide **~33 full articles** plus Hunan and Nanfang via RSS. The 3 remaining sources (Yunnan, Sichuan, Fujian) are covered by tomorrow's cron.

#### RSS scraper

RSS sources use a shared `scrapeRss()` function:
- Tries `rsshub.rssforever.com` first, then `rsshub.app` as fallback
- 8-second timeout per attempt — fails gracefully with `[]` if both instances are unreachable
- Parses RSS 2.0 and Atom feeds; handles `<![CDATA[...]]>` wrappers and inline HTML in descriptions
- Articles stored with `parse_type = 'rss'` in both `temp_articles` and `intel_articles`
- Pass 1 analysis runs normally on important RSS articles — the AI translates and summarises the excerpt it receives; `full_text_en` reflects that limited input

**Dashboard treatment of RSS articles:**
- Amber **RSS** badge visible in Today's Feed, Intel Briefing drawer, and Archive cards
- Instead of "Full Translation" block, the drawer shows an amber notice box explaining the limitation plus a "Read full article →" link to the original source
- Users can use the source link + browser built-in translate (e.g. Chrome's page translate) to read the complete Chinese original

#### Text extraction

`HTMLRewriter` selects only semantic content tags: `h1`, `h2`, `h3`, `h4`, `p`. Blocked before extraction: `script`, `style`, `nav`, `header`, `footer`, `aside`, `noscript`. Whitespace is collapsed. No HTML attributes, class names, CSS, or structural markup reaches the AI.

---

## Two-pass AI pipeline

**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Cloudflare Workers AI — free tier)

Two sequential AI calls per run.

### Pass 1 — Combined filter + analyse

All scraped articles sent to Llama with their title and a 200-character body snippet. The model judges importance from actual content (not titles alone) and produces full analysis for important articles in the same call. This replaces the previous two-call approach (title-only filter → separate analysis) which was under-flagging articles because it couldn't see body text at the filter stage.

**Input per article:**
```json
{ "index": 0, "title": "Chinese title", "snippet": "First 200 chars of body text" }
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

For `important: false` articles, `summary`, `full_text_en`, and `category` are empty strings — only `title_en` and `reason` are populated.

**Marked important** (aim 40–60%, when in doubt mark important): military movements/procurement/doctrine, senior national or provincial leadership decisions, bilateral diplomacy and cross-border events, economic policy with international implications, technology with strategic or dual-use potential, significant unrest or politically sensitive events.

**Marked not important:** local infrastructure, sports/entertainment/tourism, routine agriculture/weather/education, advertising, administrative notices, provincial economic statistics with no international angle, party study campaigns, purely domestic trade fairs or signing ceremonies.

The `title_en` and `reason` for all articles (included and excluded) are stored in `temp_articles` and shown in the Today's Feed dashboard — so you can audit filter decisions over time.

**Token budget:**
| Item | Value |
|---|---|
| Input per article | title (~50 chars) + snippet (200 chars) ≈ 250 chars |
| Total input budget | 8,000 chars → covers ~30 articles safely |
| `max_tokens` output | 4,096 |
| Model context window | 24,000 tokens | System ~800 + input ~12k + output ~4k ≈ 16,800 — safe |

### Pass 2 — Cluster

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

Both passes handle both shapes via a shared `extractAiText()` helper. The model is Llama in all cases.

If a pass fails to produce a parseable JSON array, a hard fallback fires: Pass 1 treats all articles as important with stub analysis; Pass 2 treats each article as its own cluster. No data is ever lost.

---

## Three-tier article storage

| Tier | Table | Content | Duration | AI work |
|---|---|---|---|---|
| **Feed** | `temp_articles` | All scraped articles, title + importance reason | ~24h — deleted at next morning run | Pass 1 (title_en + reason for all) |
| **Briefing** | `intel_articles` + `intel_clusters` | Important articles, fully analysed and clustered | 30 days → auto-cleanup | Pass 1 + 2 |
| **Preserved** | `intel_articles` (`is_preserved=1`) | Hand-preserved articles | Permanent | Pass 1 + 2 |

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
| Guangxi Daily | Guangxi | ✅ ~19 articles (full text) via epaper API | ✅ |
| Hainan Daily | Hainan | ✅ ~14 articles (full text) via static HTML | ✅ |
| Hunan Daily | Hunan | ⚡ RSS via RSSHub `/hnrb` (title + excerpt) | ✅ |
| Nanfang Daily | Guangdong | ⚡ RSS via RSSHub `/southcn/nfapp/column/38` (title + excerpt) | ✅ |
| Yunnan Daily | Yunnan | ❌ 403 Forbidden | ✅ |
| Sichuan Daily | Sichuan | ❌ JS-rendered SPA | ✅ |
| Fujian Daily | Fujian | ❌ JS-rendered | ✅ |

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
| `is_important` | INTEGER | 0 = skipped by filter, 1 = important (goes to intel_articles) |
| `importance_reason` | TEXT | One-sentence AI explanation for the decision |
| `cluster_id` | INTEGER | FK → intel_clusters; backfilled after Pass 2 for important articles |
| `parse_type` | TEXT | `'full'` = complete body scraped; `'rss'` = RSS title + excerpt only |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_clusters` — one row per story cluster

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | YYYY-MM-DD, CST |
| `title` | TEXT | Synthesised English headline (Pass 2 cluster) |
| `summary` | TEXT | Combined multi-source assessment (Pass 2 cluster) |
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
| `title` | TEXT | English translation (Pass 1) |
| `summary` | TEXT | 2–3 sentence geopolitical analysis |
| `full_text` | TEXT | Original Chinese body text |
| `full_text_en` | TEXT | Complete English translation |
| `url` | TEXT | Source article URL |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `source` | TEXT | Paper name |
| `is_preserved` | INTEGER | 0 = normal, 1 = exempt from 30-day cleanup |
| `parse_type` | TEXT | `'full'` = complete body scraped; `'rss'` = RSS title + excerpt only |
| `created_at` | TEXT | `datetime('now')` default |

---

## Dashboard features

| Feature | Detail |
|---|---|
| **Cluster cards** | One card per story — synthesised headline, combined summary, multi-source badge, category + HIGH indicators |
| **Publisher perspectives drawer** | Slide-in panel showing each source's own title, summary, full translation, 中文 source toggle, and per-article preserve |
| **Today's Feed** | All scraped articles grouped by source, ✓/— badges with AI reasoning for each filter decision; important articles show "View Full Analysis" button opening the cluster drawer directly; RSS-only articles display an amber **RSS** badge |
| **Preserve / Delete** | Cluster-level (all articles in cluster) with per-article override in drawer; preserved articles exempt from cleanup |
| **Archive** | Dedicated view of all preserved articles across all dates |
| **Search** | Two search bars (sidebar bottom + briefing header) share identical behaviour: typing filters the sidebar nav live for quick orientation; pressing **Enter** or clicking **Search** commits the query and opens a dedicated results page showing all matching clusters across **all dates**, grouped by date (newest first); supports title, summary, source, and **category tag** matching (e.g. search `military`, `political`); clearing returns to the previous view |
| **Print Briefing** | `window.print()` with sidebar hidden |
| **Dark / light mode** | Toggle in sidebar header; preference persists via `localStorage` across sessions |
| **State persistence** | Active view, selected briefing date persist via `sessionStorage`; sidebar open/collapsed state and dark mode persist via `localStorage` |
| **Collapsible sidebar** | Collapses on both mobile and desktop via the `←` button; defaults to open on desktop, closed on mobile; state saved in `localStorage` |
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
│   │   │   ├── xmlText()               Extract text from XML tag; handles CDATA wrappers
│   │   │   ├── stripHtml()             Strip HTML tags from RSS description strings
│   │   │   ├── parseRssXml()           Parse RSS 2.0 / Atom feed XML → ScrapedArticle[] with parse_type='rss'
│   │   │   ├── scrapeRss()             Fetch RSSHub feed with 8s timeout; tries RSSHUB_INSTANCES in order
│   │   │   ├── fetchAndParseSources()   Orchestrates all fetch + RSS scrapers in parallel
│   │   │   ├── scrapeUrl()              Puppeteer per-source scraper (cron path only)
│   │   │   ├── extractAiText()          Shared helper — handles both Workers AI response envelopes
│   │   │   ├── extractJsonArray()       Shared helper — finds best JSON array in raw AI text
│   │   │   ├── filterAndAnalyseWithAI() Pass 1 — combined filter + analysis using title + 200-char snippet
│   │   │   ├── clusterArticlesWithAI()  Pass 2 — group same-topic articles across sources
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

> **Existing deployment:** if you already have the database, just run the migration to add the `parse_type` column to both tables:
> ```bash
> npx wrangler d1 migrations apply intel_briefings_db --remote
> ```
> Migration `0007_add_parse_type.sql` is idempotent — existing rows keep `DEFAULT 'full'` and no data is lost.

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
| AI Pass 1 — filter + analyse | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — combined filter + analysis using title + snippet (~8k chars) |
| AI Pass 2 — clustering | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — cross-source story grouping |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email | Resend API — table-layout HTML template (mobile Gmail compatible) |
| Dashboard | Next.js 16 App Router via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + Shadcn UI |
| Fonts | DM Serif Display + Inter + Geist Mono via `next/font/google` |
| Icons | Tabler Icons |
