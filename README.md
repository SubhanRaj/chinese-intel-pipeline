# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes Chinese provincial newspapers every morning, analyses and translates the content with Cloudflare Workers AI (Llama 3.3 70B), and serves structured English briefings through an interactive Next.js dashboard with daily email dispatch.

## Architecture

```
   curl / browser ──┐
   cron 30 1 * * * ─┴──► runPipeline()
                              │
                    ┌─────────▼──────────────────────────┐
                    │         SCRAPING LAYER              │
                    │                                     │
                    │  1. Try Puppeteer (Browser Rendering)
                    │     └─ on 429 / crash → fallback   │
                    │  2. Fetch Engine (no browser)       │
                    │     ├─ Guangxi: epaper API scraper  │
                    │     ├─ Hainan:  static HTML parser  │
                    │     └─ Others:  HTMLRewriter generic│
                    └─────────┬──────────────────────────┘
                              │  ScrapedArticle[]
                    ┌─────────▼──────────────────────────┐
                    │         AI ANALYSIS LAYER           │
                    │                                     │
                    │  Llama 3.3 70B (Workers AI)         │
                    │  → English title + summary          │
                    │  → Full translation                 │
                    │  → Category classification         │
                    └─────────┬──────────────────────────┘
                              │  AiArticle[]
                    ┌─────────▼──────────────────────────┐
                    │     STORAGE + DISPATCH LAYER        │
                    │                                     │
                    │  D1 upsert (intel_briefings +       │
                    │            intel_articles)          │
                    │  30-day cleanup (unpreserved)       │
                    │  Resend email (Shadcn template)     │
                    └─────────┬──────────────────────────┘
                              │
                   Cloudflare D1 (SQLite)
                              │
                    ┌─────────▼──────────────────────────┐
                    │           DASHBOARD                 │
                    │  Next.js 16 · Cloudflare Worker     │
                    │  Article cards · drawer · search    │
                    │  Preserve / Delete · dark mode      │
                    └────────────────────────────────────┘
```

**Cron schedule:** `30 1 * * *` UTC = **09:30 CST** — after morning editions publish.

---

## Scraping strategy

The pipeline uses a **two-tier scraping model**. Puppeteer (Cloudflare Browser Rendering) is tried first on every run. If it fails for any reason — 429 rate limit, browser crash, quota exhaustion — the fetch engine takes over automatically, no human intervention required.

### Tier 1 — Puppeteer (Browser Rendering)

Full headless Chromium. Navigates the index page, collects up to 25 sub-page links per source, fetches each as a separate article. Images, stylesheets, and fonts are aborted at the request interceptor to minimise execution time. Used for all 7 sources when available.

### Tier 2 — Fetch Engine (zero browser, zero quota)

Native `fetch()` + `HTMLRewriter` (built into the Workers runtime — no npm dependency).

| Source | Strategy | How it works |
|---|---|---|
| **Guangxi Daily** | Dedicated API scraper | Fetches the epaper index (`/json/interface/epaper/api.php?`), extracts all article links (`code` + `xuhao` params) from inline `<area>` map tags, then fetches each article page individually. Yields ~19 articles per run. |
| **Hainan Daily** | Static HTML parser | Fetches the node page (e.g. `node_58471.htm`), parses inline JS `var map_NODE = { l: ["content_*.htm"] }` to get article file paths, fetches each. Yields ~14 articles per run. |
| **Others** | Generic HTMLRewriter | Fetches index URL, extracts text from `h1`–`h4` and `p` tags only. Falls back silently if the page is JS-rendered (returns < 100 chars of text). |

**Current fetch fallback status per source:**

| Paper | Fetch result | Reason |
|---|---|---|
| Guangxi Daily | ✅ ~19 articles | Epaper API + static article pages |
| Hainan Daily | ✅ ~14 articles | Static HTML with embedded article list |
| Yunnan Daily | ❌ 403 Forbidden | Blocks non-browser requests |
| Sichuan Daily | ❌ 0 chars | JS-rendered SPA |
| Hunan Daily | ❌ 0 chars | Vue SPA (`<noscript>` only) |
| Fujian Daily | ❌ 22 chars | JS-rendered SPA |
| Nanfang Daily | ❌ 0 chars | JS-rendered SPA |

When Puppeteer is available all 7 sources are scraped. When only the fetch engine runs, Guangxi + Hainan provide ~33 real articles which is sufficient for daily briefings.

### Text extraction

`HTMLRewriter` selects only semantic content tags: `h1`, `h2`, `h3`, `h4`, `p`. Script, style, nav, header, footer, aside, and noscript regions are explicitly blocked before extraction. Whitespace is collapsed. No HTML attributes, class names, or structural tags reach the AI.

---

## AI analysis

**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Cloudflare Workers AI — free tier, Llama 3.3 70B)

### Input limits

Chinese text tokenises at roughly 2 tokens per character on Llama models. The pipeline enforces:

| Limit | Value | Why |
|---|---|---|
| Per-article text | 300 chars | ~600 tokens per article |
| Total JSON input | 6,000 chars | ~12,000 tokens |
| `max_tokens` output | 4,096 | Default 256 was truncating JSON arrays |
| Model context window | 24,000 tokens | System prompt (~500) + input (~12k) + output (~4k) ≈ 16,500 — safe margin |

### Response format handling

Workers AI returns two different envelope shapes depending on whether `max_tokens` is set:

| Condition | Response shape | Key |
|---|---|---|
| Default (no `max_tokens`) | `{ response: string }` | `response.response` |
| With `max_tokens` set | OpenAI-compat `{ choices: [...] }` | `choices[0].message.content` |

The pipeline handles both. The underlying model is Llama in both cases — only the API envelope differs.

### Output schema

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

If the AI response cannot be parsed as a valid JSON array, a hard fallback saves each article with `summary: 'Analysis unavailable.'` and `category: 'Uncategorized'` so data is never lost.

---

## Email

Daily briefings are dispatched via **Resend** using a Shadcn light-mode HTML template:

- Slate background (`#f8fafc`), white article cards, red accent (`#ef4444`)
- Each card: English headline, 2–3 sentence summary, source URL link
- Subject: `China Intel Briefing — YYYY-MM-DD`
- Sent to `RESEND_TO_EMAIL` from `RESEND_FROM_EMAIL`

Email is **disabled by default** (`ENABLE_EMAIL` must be set to `"true"` as a Worker secret).

---

## Triggering the pipeline

```bash
# Manual HTTP trigger — runs full pipeline, returns plain-text result
curl https://scraper-worker.shubhanraj2002.workers.dev

# Cron fires automatically at 01:30 UTC daily
# Local dev simulation
cd scraper-worker && npm run dev
curl "http://localhost:8787/__scheduled?cron=30+1+*+*+*"
```

The pipeline is **idempotent** — re-triggering on the same CST date returns `Already processed <date>, skipping.`

---

## Sources

| Paper | Province | Fetch strategy |
|---|---|---|
| Yunnan Daily | Yunnan | Puppeteer only |
| Sichuan Daily | Sichuan | Puppeteer only |
| Guangxi Daily | Guangxi | Puppeteer + dedicated API fallback |
| Hunan Daily | Hunan | Puppeteer only (Vue SPA) |
| Fujian Daily | Fujian | Puppeteer only |
| Nanfang Daily | Guangdong | Puppeteer only |
| Hainan Daily | Hainan | Puppeteer + static HTML fallback |

---

## Database schema

### `intel_briefings` — daily parent record

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT UNIQUE | YYYY-MM-DD, CST |
| `raw_scraped_text` | TEXT | concatenated source text |
| `ai_analysis_markdown` | TEXT | `'articles'` sentinel for new runs; legacy Markdown for old ones |
| `email_status` | INTEGER | 0 = not sent, 1 = sent |

### `intel_articles` — per-article rows

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | FK → intel_briefings |
| `title` | TEXT | English translation |
| `summary` | TEXT | 2–3 sentence geopolitical analysis |
| `full_text` | TEXT | Original Chinese body text |
| `full_text_en` | TEXT | Complete English translation |
| `url` | TEXT | Source article URL |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `source` | TEXT | Paper name (e.g. Guangxi Daily) |
| `is_preserved` | INTEGER | 0 = normal, 1 = exempt from 30-day cleanup |
| `created_at` | TEXT | `datetime('now')` default |

---

## Dashboard features

- **Article cards** — English title, AI geopolitical summary, source paper badge, category tag, HIGH badge for flagged items
- **Slide-in drawer** — full English translation + 中文 toggle for original Chinese text
- **Preserve / Delete** — server actions; preserved articles exempt from 30-day cleanup; drawer has Unpreserve & Delete atomic action
- **Search** — live client-side filter across title, summary, source
- **Preserved archive** — dedicated sidebar section showing all preserved articles across all dates
- **Print Briefing** — `window.print()` with sidebar hidden
- **Dark / light mode** — toggles in sidebar; defaults to light
- **PWA** — installable via `manifest.json`; theme matches red brand accent
- **Mobile responsive** — sidebar collapses; hamburger button; drawer goes full-width

---

## Security

| Surface | Protection |
|---|---|
| Server Actions | Input validated server-side; `deleteArticle` re-checks `is_preserved = 0` in D1; `unpreserveAndDelete` is atomic |
| URL rendering | All `href` values pass through `safeUrl()` — only `http://` and `https://` allowed |
| Content rendering | Article text as React text nodes, never `dangerouslySetInnerHTML` |
| Secrets | `RESEND_API_KEY`, `RESEND_TO_EMAIL`, `RESEND_FROM_EMAIL`, `ENABLE_EMAIL` stored as Wrangler secrets — never in source or git |

---

## Project layout

```
chinese-intel-pipeline/
├── scraper-worker/
│   ├── migrations/
│   │   ├── 0001_add_articles_table.sql
│   │   └── 0002_add_full_text_en.sql
│   ├── src/
│   │   ├── index.ts          # All pipeline logic
│   │   │   ├── fetchHtml()         fetch wrapper with UA + Referer
│   │   │   ├── extractText()       HTMLRewriter — h1/h2/h3/h4/p only
│   │   │   ├── scrapeGuangxi()     API-based dedicated scraper
│   │   │   ├── scrapeHainan()      Static HTML dedicated scraper
│   │   │   ├── scrapeGeneric()     HTMLRewriter fallback
│   │   │   ├── fetchAndParseSources()  orchestrates all fetch scrapers
│   │   │   ├── scrapeUrl()         Puppeteer per-source scraper
│   │   │   ├── analyseWithWorkersAI()  Llama 3.3 70B call + JSON parse
│   │   │   ├── sendEmail()         Resend + Shadcn HTML template
│   │   │   └── runPipeline()       main orchestrator (Puppeteer → fetch fallback)
│   │   └── db/schema.ts      # Drizzle ORM schema
│   └── wrangler.jsonc        # AI, BROWSER, D1 bindings; cron 30 1 * * *
└── dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── actions.ts     # Server Actions: togglePreserve, deleteArticle, unpreserveAndDelete
    │   │   ├── layout.tsx     # Metadata, fonts
    │   │   ├── page.tsx       # Server component D1 query
    │   │   └── globals.css    # Tailwind v4 + Shadcn tokens
    │   ├── components/
    │   │   ├── IntelViewer.tsx      # Client: sidebar, cards, drawer, dark toggle, search
    │   │   ├── MarkdownRenderer.tsx # Legacy briefings (react-markdown, ssr:false)
    │   │   └── ui/                  # Shadcn primitives
    │   └── db/schema.ts       # Drizzle ORM (mirrors scraper-worker)
    └── wrangler.jsonc         # Worker-mode deploy
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
| Scraper — primary | Cloudflare Workers + `@cloudflare/puppeteer` (Browser Rendering) |
| Scraper — fallback | Native `fetch()` + `HTMLRewriter` (built into Workers runtime) |
| AI model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Cloudflare Workers AI (free tier) |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email | Resend API — Shadcn light-mode HTML template |
| Dashboard | Next.js 16 App Router via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + Shadcn UI |
| Fonts | DM Serif Display + Inter + Geist Mono via `next/font/google` |
| Icons | Tabler Icons |
