# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes Chinese provincial newspapers every morning, analyses and translates the content with Cloudflare Workers AI (Llama 3.3 70B), and serves structured English briefings through an interactive Next.js dashboard with daily email dispatch.

## Architecture

```
   curl / browser ──────────────────────────────────► fetch handler
                                                        │ fetch engine only
                                                        │ (no Puppeteer, ever)
                                                        │
   cron 30 1 * * * ──────────────────────────────────► scheduled handler
                                                        │ Puppeteer first
                                                        │ → fetch fallback on failure
                                                        │
                                            ┌───────────▼──────────────────────┐
                                            │         SCRAPING LAYER            │
                                            │                                   │
                                            │  Tier 1 — Puppeteer               │
                                            │  Full headless Chromium · 7 srcs  │
                                            │  → on 429 / crash → Tier 2       │
                                            │                                   │
                                            │  Tier 2 — Fetch Engine            │
                                            │  ├─ Guangxi: epaper API scraper   │
                                            │  ├─ Hainan:  static HTML parser   │
                                            │  └─ Others:  HTMLRewriter generic │
                                            └───────────┬──────────────────────┘
                                                        │  ScrapedArticle[]
                                            ┌───────────▼──────────────────────┐
                                            │       AI PASS 1 — FILTER          │
                                            │                                   │
                                            │  Llama 3.3 70B                    │
                                            │  Input: all titles only (~6k tok) │
                                            │  Output: important? + reason      │
                                            └───────────┬──────────────────────┘
                                                        │
                                          ┌─────────────┴─────────────┐
                                          │                           │
                              ALL articles                    Important subset
                              → temp_articles                         │
                              (24h, feed view)        ┌──────────────▼────────────┐
                                                       │    AI PASS 2 — ANALYSE    │
                                                       │                           │
                                                       │  Llama 3.3 70B            │
                                                       │  Input: full text (~12k)  │
                                                       │  Output: title_en +       │
                                                       │  summary + translation +  │
                                                       │  category                 │
                                                       └──────────────┬────────────┘
                                                                      │  AiArticle[]
                                            ┌─────────────────────────▼────────────┐
                                            │        STORAGE + DISPATCH LAYER       │
                                            │                                       │
                                            │  intel_articles upsert                │
                                            │  intel_briefings parent record        │
                                            │  30-day cleanup (unpreserved)         │
                                            │  Resend email (Shadcn template)       │
                                            └─────────────────────────┬────────────┘
                                                                      │
                                                         Cloudflare D1 (SQLite)
                                                                      │
                                            ┌─────────────────────────▼────────────┐
                                            │              DASHBOARD                │
                                            │  Next.js 16 · Cloudflare Worker       │
                                            │                                       │
                                            │  Today's Feed  — all articles 24h     │
                                            │  Intel Briefing — important, 30 days  │
                                            │  Archive        — preserved, forever  │
                                            └──────────────────────────────────────┘
```

**Cron schedule:** `30 1 * * *` UTC = **09:30 CST** — after morning editions publish.

---

## Trigger modes

The HTTP handler and the cron handler run fundamentally different paths — this is enforced in code, not via URL parameters.

| Trigger | How | Puppeteer | Idempotency | Use for |
|---|---|---|---|---|
| `curl https://scraper-worker…` | HTTP GET | Never — fetch engine only | Skipped — always executes | Manual testing |
| Cron `30 1 * * *` | Cloudflare scheduler | Yes, primary path | Enforced — once per CST date | Production daily run |

This means you can trigger the worker via curl any number of times for testing without consuming any Browser Rendering quota. The cron job is the only path that ever launches Puppeteer.

---

## Scraping strategy

### Tier 1 — Puppeteer (cron only)

Full headless Chromium via Cloudflare Browser Rendering. Navigates each source's index page, collects up to 25 sub-page links, fetches each article. Images, stylesheets, and fonts are aborted at the request interceptor to reduce execution time. Covers all 7 sources when available. Falls back to Tier 2 automatically on any failure (429, crash, quota exhaustion).

### Tier 2 — Fetch Engine (HTTP trigger + cron fallback)

Native `fetch()` + `HTMLRewriter` — no npm dependency, no browser, no quota.

#### What the fetch engine can scrape

| Source | Strategy | Detail |
|---|---|---|
| **Guangxi Daily** | Dedicated API scraper ✅ | Fetches the epaper index at `ssw.gxrb.com.cn/json/interface/epaper/api.php?`, extracts all article links from inline `<area>` map tags (`code` + `xuhao` params), then fetches each article page individually. Skips editor credit lines (`责任编辑`, `客户端`, `版责`, `广西云`). Yields **~19 articles** per run. |
| **Hainan Daily** | Static HTML parser ✅ | Fetches the node page (e.g. `node_58471.htm`), parses inline JS `var map_NODE = { l: ["content_*.htm"] }` to get the article file list, fetches each file from the same directory. Yields **~14 articles** per run. |
| **Yunnan Daily** | Generic HTMLRewriter ❌ | Returns HTTP 403 — server blocks non-browser User-Agent regardless of spoofing. Puppeteer only. |
| **Sichuan Daily** | Generic HTMLRewriter ❌ | JavaScript-rendered SPA — `fetch()` receives a nearly empty shell with `<noscript>` only. Puppeteer only. |
| **Hunan Daily** | Generic HTMLRewriter ❌ | Vue SPA — same issue as Sichuan. Puppeteer only. |
| **Fujian Daily** | Generic HTMLRewriter ❌ | JS-rendered — returns ~22 chars of usable text. Puppeteer only. |
| **Nanfang Daily** | Generic HTMLRewriter ❌ | JS-rendered SPA — returns 0 usable chars. Puppeteer only. |

When only the fetch engine runs (HTTP trigger or Puppeteer failure), Guangxi + Hainan provide **~33 real articles** — sufficient for daily briefings. The 5 remaining sources require Puppeteer and are covered by tomorrow's cron.

#### Text extraction

`HTMLRewriter` selects only semantic content tags: `h1`, `h2`, `h3`, `h4`, `p`. The following regions are explicitly blocked before extraction so their text never reaches the selector: `script`, `style`, `nav`, `header`, `footer`, `aside`, `noscript`. Whitespace is collapsed. No HTML attributes, class names, CSS, or structural markup reaches the AI.

---

## AI pipeline

**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Cloudflare Workers AI — free tier)

The pipeline makes **two separate AI calls per run**. This keeps token usage low: Pass 1 is cheap (titles only), Pass 2 is expensive but runs on a small filtered subset.

### Pass 1 — Filter

All scraped article titles are sent to Llama. The model evaluates each title for geopolitical and strategic significance and returns a decision + one-sentence reason for every article.

**Marked important (included in Pass 2):**
- Military movements, exercises, procurement, or doctrine
- Senior leadership decisions, speeches, or personnel changes
- Foreign policy, diplomacy, or cross-border events
- Economic policy with international implications
- Technology programs with strategic or dual-use potential
- Significant social unrest, disasters, or politically notable events

**Marked not important (title-translated only, visible in Today's Feed):**
- Purely local infrastructure (roads, parks, municipal works)
- Sports, entertainment, cultural festivals
- Routine agriculture, weather, community services
- Advertising copy, editorial credits, routine notices

Token budget for Pass 1:

| Item | Value |
|---|---|
| Input (all titles) | ~33 titles × ~50 chars × 2 tok/char ≈ **3,300 tokens** |
| Output (decisions + reasons) | ~33 entries × ~80 chars ≈ **1,300 tokens** |
| Total | **~4,600 tokens** — very cheap |

### Pass 2 — Deep analysis

Runs only on the important subset (~8–12 articles). Produces full English translation, geopolitical summary, and category classification.

| Limit | Value | Why |
|---|---|---|
| Per-article text | 400 chars | ~800 tokens per article; more per article since fewer articles now |
| Total JSON input | 6,000 chars | ~12,000 tokens |
| `max_tokens` output | 4,096 | Default 256 truncates JSON arrays |
| Model context window | 24,000 tokens | System prompt (~500) + input (~12k) + output (~4k) ≈ 16,500 — safe margin |

### Response format handling

Workers AI returns two different envelope shapes depending on whether `max_tokens` is set:

| Condition | Response shape | Key |
|---|---|---|
| Default (no `max_tokens`) | `{ response: string }` | `response.response` |
| With `max_tokens` set | OpenAI-compat `{ choices: [...] }` | `choices[0].message.content` |

Both passes handle both shapes. The underlying model is Llama in both cases — only the API envelope differs.

### Output schema (Pass 2)

```json
[
  {
    "title": "English translation of the Chinese headline",
    "summary": "2–3 sentence geopolitical analysis. [HIGH] if significant.",
    "full_text_en": "Complete faithful English translation of the article body",
    "url": "original source URL unchanged",
    "category": "Political | Military | Economic | Technology | Social | Foreign Affairs"
  }
]
```

If either AI response cannot be parsed as a valid JSON array, a hard fallback fires: Pass 1 treats all articles as important; Pass 2 saves each with `summary: 'Analysis unavailable.'` so no data is ever lost.

---

## Three-tier article storage

| Tier | Table | Content | Duration | AI work done |
|---|---|---|---|---|
| **Feed** | `temp_articles` | All scraped articles, title translated | ~24h — deleted at next morning run | Pass 1 only |
| **Briefing** | `intel_articles` | Important articles, fully analysed | 30 days → auto-cleanup | Pass 1 + Pass 2 |
| **Preserved** | `intel_articles` (`is_preserved=1`) | Hand-preserved articles | Permanent | Pass 1 + Pass 2 |

The `temp_articles` table is cleared at the start of each pipeline run (before inserting today's articles). This means today's full feed is visible in the dashboard until the next morning run replaces it.

---

## Dashboard views

### Today's Feed
All articles scraped today, grouped by source (Guangxi Daily, Hainan Daily, etc.). Each article shows:
- **✓ green** — AI flagged as important; went to full analysis; appears in Intel Briefing
- **— grey** — AI skipped; title translated only; original source link still available
- One-sentence AI reasoning for every decision (both included and excluded)

This view is intentionally ephemeral — it exists so you can audit the filter decisions and improve the importance criteria over time. The reasoning for exclusions is stored alongside the article so you can see exactly what the model decided and why.

### Intel Briefing
Important articles with full English translation, geopolitical summary, category badge, and [HIGH] flag for significant items. Visible for 30 days. Slide-in drawer shows the full translated article + toggle to read the original Chinese source text.

### Archive (Preserved)
Articles manually preserved via the bookmark button. Exempt from the 30-day cleanup. Visible permanently.

### Search
Live client-side filter across title, summary, and source. Available in Briefing and Archive views.

---

## Email

Daily briefings are dispatched via **Resend** using a Shadcn light-mode HTML template:

- Slate background (`#f8fafc`), white article cards, red accent (`#ef4444`)
- Each card: English headline, 2–3 sentence summary, source URL link
- Subject: `China Intel Briefing — YYYY-MM-DD`
- Sent to `RESEND_TO_EMAIL` from `RESEND_FROM_EMAIL`
- Contains **important articles only** (Pass 2 output) — not the full feed

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
| `is_important` | INTEGER | 0 = skipped, 1 = sent to Pass 2 |
| `importance_reason` | TEXT | One-sentence AI explanation |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_briefings` — daily parent record

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT UNIQUE | YYYY-MM-DD, CST |
| `raw_scraped_text` | TEXT | concatenated source text |
| `ai_analysis_markdown` | TEXT | `'articles'` sentinel for new runs; legacy Markdown for old ones |
| `email_status` | INTEGER | 0 = not sent, 1 = sent |

### `intel_articles` — per-article rows (important + preserved)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | FK → intel_briefings |
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

## Security

| Surface | Protection |
|---|---|
| Server Actions | Input validated server-side; `deleteArticle` re-checks `is_preserved = 0` in D1; `unpreserveAndDelete` is atomic |
| URL rendering | All `href` values pass through `safeUrl()` — only `http://` and `https://` allowed |
| Content rendering | Article text as React text nodes, never `dangerouslySetInnerHTML` |
| No file upload endpoints | The worker accepts no uploads, form posts, or arbitrary payloads — only preserve/delete server actions |
| Trigger hardening | HTTP trigger is hardcoded to fetch-only in the Worker source — no URL parameter can activate Puppeteer or override pipeline behaviour |
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
│   │   └── 0004_add_temp_articles.sql
│   ├── src/
│   │   ├── index.ts                    # All pipeline logic
│   │   │   ├── fetchHtml()             fetch wrapper with UA + Referer
│   │   │   ├── extractText()           HTMLRewriter — h1/h2/h3/h4/p only; blocks script/style/nav/header/footer/aside/noscript
│   │   │   ├── scrapeGuangxi()         Epaper API scraper — index page → article links → individual fetch
│   │   │   ├── scrapeHainan()          Static HTML parser — node page JS var → content files → fetch
│   │   │   ├── scrapeGeneric()         HTMLRewriter fallback — silently returns [] for JS-rendered pages
│   │   │   ├── fetchAndParseSources()  Orchestrates all fetch scrapers in parallel
│   │   │   ├── scrapeUrl()             Puppeteer per-source scraper (cron only)
│   │   │   ├── extractAiText()         Shared helper — handles both Workers AI response envelopes
│   │   │   ├── extractJsonArray()      Shared helper — finds best JSON array in raw AI text
│   │   │   ├── filterArticlesWithAI()  Pass 1 — filter by title, returns importance + reason per article
│   │   │   ├── analyseWithWorkersAI()  Pass 2 — deep analysis on important subset only
│   │   │   ├── sendEmail()             Resend + Shadcn HTML template
│   │   │   └── runPipeline()           Main orchestrator; fetch() passes fetchOnly=true, scheduled() passes false
│   │   └── db/schema.ts                Drizzle ORM schema (intelBriefings, intelArticles, tempArticles)
│   └── wrangler.jsonc                  AI, BROWSER, D1 bindings; cron 30 1 * * *
└── dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── actions.ts              Server Actions: togglePreserve, deleteArticle, unpreserveAndDelete
    │   │   ├── layout.tsx              Metadata, fonts
    │   │   ├── page.tsx                Server component — queries briefings, articles, feed (temp_articles)
    │   │   └── globals.css             Tailwind v4 + Shadcn tokens
    │   ├── components/
    │   │   ├── IntelViewer.tsx         Client: sidebar, Today's Feed, briefing cards, drawer, search, dark toggle
    │   │   ├── MarkdownRenderer.tsx    Legacy briefings (react-markdown, ssr:false)
    │   │   └── ui/                     Shadcn primitives
    │   └── db/schema.ts                Drizzle ORM (mirrors scraper-worker)
    └── wrangler.jsonc                  Worker-mode deploy
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

This runs the full two-pass pipeline via fetch engine only (Guangxi + Hainan, ~33 articles). The dashboard will show Today's Feed and the Intel Briefing once complete. The first cron run at 01:30 UTC will execute the Puppeteer path across all 7 sources.

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
| AI filtering | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — Pass 1, titles only |
| AI analysis | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — Pass 2, important subset |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email | Resend API — Shadcn light-mode HTML template |
| Dashboard | Next.js 16 App Router via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + Shadcn UI |
| Fonts | DM Serif Display + Inter + Geist Mono via `next/font/google` |
| Icons | Tabler Icons |
