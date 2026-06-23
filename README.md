# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes seven Chinese provincial newspapers every morning, analyses and translates the content with Cloudflare Workers AI, and serves structured English briefings through an interactive Next.js dashboard.

## Architecture

```
                        ┌──────────────────────────────────────────────────┐
                        │                scraper-worker                     │
                        │            Cloudflare Worker (cron)               │
                        │                                                   │
   curl / browser ────► │  fetch()       ─┐                                │
   cron 30 1 * * * ───► │  scheduled()   ─┴─► runPipeline()                │
                        │                      │                            │
                        │  1. CST date         │                            │
                        │  2. Puppeteer* ──────┤ 7 provincial papers       │
                        │  3. Workers AI ───── │ JSON: title, summary,     │
                        │     (Llama 3.3 70B)  │ full_text_en per article  │
                        │  4. D1 upsert  ◄─────┘                           │
                        │  5. 30-day cleanup                               │
                        │  6. Resend email (optional)                      │
                        └────────────────┬─────────────────────────────────┘
                                         │
                              Cloudflare D1 (SQLite)
                          intel_briefings + intel_articles
                                         │
                        ┌────────────────▼─────────────────────────────────┐
                        │                 dashboard                         │
                        │     Next.js 16 · Cloudflare Worker               │
                        │     (via @opennextjs/cloudflare)                 │
                        │                                                   │
                        │  Server component  → D1 query (force-dynamic)   │
                        │  Article cards     → title, summary, actions     │
                        │  Slide-in drawer   → full English + 中文 toggle  │
                        │  Preserve / Delete → Next.js Server Actions      │
                        │  Dark / light mode → Playfair Display + Tabler  │
                        └──────────────────────────────────────────────────┘
```

\* Puppeteer is currently bypassed with mock articles while the Browser Rendering free-tier daily quota resets. See [Restoring live scraping](#restoring-live-scraping).

**Cron schedule:** `30 1 * * *` UTC = **09:30 CST** — runs once per day after morning editions publish.

## Triggering the pipeline

The worker responds to two trigger types via the shared `runPipeline()` function:

| Trigger | How | Notes |
|---|---|---|
| Cron | automatic, daily at 01:30 UTC | fires `scheduled()` handler |
| HTTP | `curl https://scraper-worker.shubhanraj2002.workers.dev` | fires `fetch()` handler, returns plain-text result |

The pipeline is **idempotent** — re-triggering on the same CST date skips the scrape and returns `Already processed <date>, skipping.`

## Sources scraped

| Paper | Province | URL pattern |
|---|---|---|
| Yunnan Daily | Yunnan | `yndaily.yunnan.cn/html/YYYY/MMDD/…` |
| Sichuan Daily | Sichuan | `4g.scdaily.cn/wap/scrb/YYYYMMDD/…` |
| Guangxi Daily | Guangxi | `ssw.gxrb.com.cn` (static, serves today) |
| Hunan Daily | Hunan | `h5cgi.voc.com.cn/hnrbdzb` (SPA) |
| Fujian Daily | Fujian | `fjrb.fjdaily.com/pad/col/YYYYMM/DD/…` |
| Nanfang Daily | Guangdong | `epaper.nfnews.com/…/YYYYMM/DD/…` |
| Hainan Daily | Hainan | `news.hndaily.cn/h5/html5/YYYY-MM/DD/…` |

Each source uses a two-step Puppeteer pass: index page → article sub-pages (up to 25). Images, stylesheets, and fonts are aborted at the request interceptor to minimise execution time.

## AI output schema

Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) is prompted to return a strict JSON array — one object per scraped article:

```json
[
  {
    "title": "English translation of the Chinese headline",
    "summary": "2–3 sentence geopolitical analysis [HIGH if significant]",
    "full_text_en": "Complete faithful English translation of the article body",
    "url": "original source URL"
  }
]
```

Articles are inserted individually into `intel_articles`. A 30-day retention cleanup runs at the end of every pipeline execution (preserved articles are exempt).

## Intel categories (legacy markdown briefings)

Older briefings stored a single Markdown blob organised into eight sections:

1. Internal Political
2. External Political / Foreign Affairs
3. National Leader Movements (Politburo Standing Committee)
4. Provincial Leader Movements
5. Economic / Commercial
6. Science & Technology
7. Social / Culture / Society
8. Common Syndicated News (Xinhua wire, listed once)

New briefings use the per-article card layout instead.

## Dashboard features

- **Article cards** — title, AI geopolitical summary, Read Full Article button, Source link
- **Slide-in drawer** — opens on "Read Full Article"; shows translated title, summary, full English translation, and a **中文 Source** toggle to reveal the original Chinese text
- **Preserve / Delete** — per-article server actions; preserved articles are exempt from the 30-day cleanup
- **Print Briefing** — `window.print()` with sidebar hidden via `print:hidden`
- **Dark / light mode** — toggle in sidebar (defaults to light); Playfair Display serif for headings
- **HIGH badge** — articles flagged `[HIGH]` by the AI get a red destructive badge

## Project layout

```
chinese-intel-pipeline/
├── scraper-worker/
│   ├── migrations/
│   │   ├── 0001_add_articles_table.sql
│   │   └── 0002_add_full_text_en.sql
│   ├── src/
│   │   ├── index.ts          # fetch + scheduled handlers → runPipeline()
│   │   └── db/schema.ts      # Drizzle ORM: intel_briefings + intel_articles
│   └── wrangler.jsonc        # AI binding, BROWSER, D1, cron 30 1 * * *
└── dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── actions.ts     # Server Actions: togglePreserve, deleteArticle
    │   │   ├── layout.tsx     # Metadata, OG tags, Playfair Display font
    │   │   ├── page.tsx       # Server component — D1 query (force-dynamic)
    │   │   └── globals.css    # Tailwind v4 + Shadcn theme + dark variant
    │   ├── components/
    │   │   ├── IntelViewer.tsx     # Client: sidebar, cards, drawer, dark toggle
    │   │   ├── MarkdownRenderer.tsx # Legacy: react-markdown (dynamic, ssr:false)
    │   │   └── ui/                 # Shadcn UI primitives (Card, Button, Badge, Accordion)
    │   ├── db/schema.ts       # Drizzle ORM schema (mirrors scraper-worker)
    │   └── env.d.ts           # CloudflareEnv augment: DB: D1Database
    └── wrangler.jsonc         # Worker-mode deploy (main + assets)
```

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
| `is_preserved` | INTEGER | 0 = normal, 1 = exempt from 30-day cleanup |
| `created_at` | TEXT | datetime('now') default |

## Email toggle

Email dispatch is **disabled by default**. The `ENABLE_EMAIL` var is set to `"false"` in `wrangler.jsonc`.

To enable:
```bash
cd scraper-worker
npx wrangler secret put ENABLE_EMAIL   # enter: true
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_TO_EMAIL
npx wrangler secret put RESEND_FROM_EMAIL
```

## Setup & deployment

### Prerequisites
- Cloudflare account with Workers, D1, Browser Rendering, and Workers AI enabled
- Wrangler CLI authenticated: `npx wrangler login`

### 1. Create the D1 database and run migrations

```bash
# Create the database (first time only)
npx wrangler d1 create intel_briefings_db

# Apply all migrations
cd scraper-worker
npx wrangler d1 migrations apply intel_briefings_db --remote
```

### 2. Deploy the scraper worker

```bash
cd scraper-worker
npm run deploy
```

### 3. Deploy the dashboard

```bash
cd dashboard
npm run deploy
```

### Test the pipeline immediately

```bash
# HTTP trigger — runs the full pipeline, returns plain-text result
curl https://scraper-worker.shubhanraj2002.workers.dev

# Local dev (cron simulation)
cd scraper-worker && npm run dev
curl "http://localhost:8787/__scheduled?cron=30+1+*+*+*"
```

## Restoring live scraping

The Puppeteer block in `scraper-worker/src/index.ts` is commented out while the Browser Rendering free-tier quota resets. To restore:

1. Uncomment the `buildUrls` + `puppeteer.launch` block
2. Remove the `scrapedArticles` mock array assignment
3. Redeploy: `cd scraper-worker && npm run deploy`

## Production URLs

| Service | URL |
|---|---|
| Dashboard | `https://dashboard.shubhanraj2002.workers.dev` |
| Worker (HTTP trigger) | `https://scraper-worker.shubhanraj2002.workers.dev` |

## Tech stack

| Layer | Technology |
|---|---|
| Scraper runtime | Cloudflare Workers + `@cloudflare/puppeteer` (Browser Rendering) |
| AI analysis | Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (free tier) |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email (optional) | Resend API |
| Dashboard | Next.js 16 App Router deployed as Cloudflare Worker via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + `@tailwindcss/typography` · Shadcn UI (base-ui variant) |
| Fonts | DM Serif Display (date + article titles) + Inter (UI/body) + Geist Mono — via `next/font/google` |
| Icons | Tabler Icons (`@tabler/icons-react`) |
| Markdown | `react-markdown` (client-only, `next/dynamic` + `ssr:false`) — legacy briefings only |
