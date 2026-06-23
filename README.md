# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes seven Chinese provincial newspapers every morning, analyses the content with Claude, and serves a structured English briefing through a web dashboard.

## Architecture

```
                        ┌──────────────────────────────────────────┐
                        │           scraper-worker                  │
                        │        Cloudflare Worker                  │
                        │                                           │
   curl / browser ────► │  fetch()     ─┐                          │
   cron 0 22 * * * ───► │  scheduled() ─┴─► runPipeline()          │
                        │                    │                      │
                        │   1. CST date      │                      │
                        │   2. Puppeteer ────┤ 7 provincial papers  │
                        │   3. Claude        │ analysis + markdown  │
                        │   4. D1 upsert  ◄──┘                      │
                        │   5. Resend email (optional)              │
                        └────────────────┬─────────────────────────┘
                                         │
                                  D1 Database
                               intel_briefings
                                         │
                        ┌────────────────▼─────────────────────────┐
                        │              dashboard                    │
                        │    Next.js 16 · Cloudflare Worker         │
                        │    (via @opennextjs/cloudflare)           │
                        │                                           │
                        │  Server component → getCloudflareContext  │
                        │  Client component → sidebar + markdown    │
                        └───────────────────────────────────────────┘
```

**Cron schedule:** `0 22 * * *` UTC = 06:00 CST — runs once per day after morning editions publish.

## Triggering the worker

The worker responds to two trigger types using the same shared `runPipeline()` function:

| Trigger | How | Notes |
|---|---|---|
| Cron | automatic, daily at 22:00 UTC | fires `scheduled()` handler |
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

Each source is scraped with a two-step Puppeteer pass: index page → article sub-pages (up to 25). Images, stylesheets, and fonts are aborted at the request interceptor to minimise execution time.

## Intel categories

Claude organises each briefing into eight sections:

1. Internal Political
2. External Political / Foreign Affairs
3. National Leader Movements (Politburo Standing Committee)
4. Provincial Leader Movements
5. Economic / Commercial
6. Science & Technology
7. Social / Culture / Society
8. Common Syndicated News (Xinhua wire, listed once)

Each article includes: original Chinese title, English translation, page reference, and a geopolitical inference where relevant. High-significance items are flagged 🔴.

## Project layout

```
chinese-intel-pipeline/
├── scraper-worker/
│   ├── src/
│   │   ├── index.ts          # fetch + scheduled handlers → shared runPipeline()
│   │   └── db/schema.ts      # Drizzle ORM schema
│   └── wrangler.jsonc        # ENABLE_EMAIL="false" default var, cron trigger
└── dashboard/
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx       # Server component — fetches briefings from D1
    │   │   └── globals.css    # Tailwind v4 + typography plugin import
    │   ├── components/
    │   │   └── IntelViewer.tsx  # Client component — sidebar + markdown viewer
    │   ├── db/schema.ts       # Drizzle ORM schema (identical to worker)
    │   └── env.d.ts           # Augments CloudflareEnv with DB: D1Database
    └── wrangler.jsonc         # Worker-mode deploy (main + assets)
```

## Email toggle

Email dispatch is **disabled by default**. The `ENABLE_EMAIL` var is set to `"false"` in `wrangler.jsonc` so no Resend secrets are required to deploy.

To enable email:
```bash
cd scraper-worker
npx wrangler secret put ENABLE_EMAIL   # enter: true
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_TO_EMAIL
npx wrangler secret put RESEND_FROM_EMAIL
```

Secrets override the `vars` default — setting `ENABLE_EMAIL="true"` as a secret activates the Resend dispatch path without any code changes.

## Setup & deployment

### Prerequisites
- Cloudflare account with Workers, D1, and Browser Rendering enabled
- Wrangler CLI authenticated: `npx wrangler login`
- Anthropic API key

### 1. Create the D1 table

```bash
npx wrangler d1 execute intel_briefings_db --remote --command \
  "CREATE TABLE IF NOT EXISTS intel_briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_date TEXT UNIQUE NOT NULL,
    raw_scraped_text TEXT,
    ai_analysis_markdown TEXT,
    email_status INTEGER DEFAULT 0
  );"
```

### 2. Set required Worker secrets

```bash
cd scraper-worker
npx wrangler secret put ANTHROPIC_API_KEY
```

### 3. Deploy the Worker

```bash
cd scraper-worker
npm run deploy
```

### 4. Deploy the Dashboard

```bash
cd dashboard
npm run deploy
```

### Test the worker immediately

```bash
# HTTP trigger — runs the full pipeline and streams logs in the response
curl https://scraper-worker.shubhanraj2002.workers.dev

# Local dev (cron simulation)
cd scraper-worker && npm run dev
curl "http://localhost:8787/__scheduled?cron=0+22+*+*+*"
```

## Production URLs

| Service | URL |
|---|---|
| Dashboard | `https://dashboard.shubhanraj2002.workers.dev` |
| Worker (HTTP trigger) | `https://scraper-worker.shubhanraj2002.workers.dev` |

## Tech stack

| Layer | Technology |
|---|---|
| Scraper runtime | Cloudflare Workers + `@cloudflare/puppeteer` |
| AI analysis | Anthropic `claude-3-5-sonnet-latest` via `@anthropic-ai/sdk` |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email (optional) | Resend API |
| Dashboard | Next.js 16 (App Router) deployed as a Cloudflare Worker via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + `@tailwindcss/typography` |
| Markdown render | `react-markdown` |
