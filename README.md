# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes seven Chinese provincial newspapers every morning, analyses the content with Claude, and delivers a structured English briefing via email.

## Architecture

```
┌─────────────────────────────┐     D1 Database      ┌──────────────────────────┐
│      scraper-worker         │ ──────────────────── │       dashboard          │
│  Cloudflare Worker (Cron)   │   intel_briefings    │  Next.js on CF Pages     │
│                             │                      │                          │
│  1. Puppeteer → 7 papers    │                      │  Left sidebar: dates     │
│  2. Claude analysis         │                      │  Right panel: markdown   │
│  3. Save to D1              │                      │  react-markdown + prose  │
│  4. Email via Resend        │                      │                          │
└─────────────────────────────┘                      └──────────────────────────┘
```

**Cron schedule:** `0 22 * * *` UTC (06:00 CST) — runs once per day after morning editions publish.

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

## Intel categories

Claude organises each briefing into:

1. Internal Political
2. External Political / Foreign Affairs
3. National Leader Movements
4. Provincial Leader Movements
5. Economic / Commercial
6. Science & Technology
7. Social / Culture / Society
8. Common Syndicated News (Xinhua wire)

## Project layout

```
chinese-intel-pipeline/
├── scraper-worker/          # Cloudflare Worker
│   ├── src/
│   │   ├── index.ts         # Scheduled handler (scrape → analyse → save → email)
│   │   └── db/schema.ts     # Drizzle ORM schema
│   └── wrangler.jsonc
└── dashboard/               # Next.js 16 app (Cloudflare Pages via OpenNext)
    ├── src/
    │   ├── app/page.tsx      # Server component — fetches briefings from D1
    │   ├── components/
    │   │   └── IntelViewer.tsx  # Client component — sidebar + markdown viewer
    │   └── db/schema.ts     # Drizzle ORM schema (identical to worker)
    └── wrangler.jsonc
```

## Setup & deployment

### Prerequisites
- Cloudflare account with Workers, D1, and Browser Rendering enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) authenticated (`npx wrangler login`)
- Resend account for email delivery

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

### 2. Set Worker secrets

```bash
cd scraper-worker
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_TO_EMAIL       # recipient address
npx wrangler secret put RESEND_FROM_EMAIL     # verified sender address
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

### Trigger a manual test run

```bash
cd scraper-worker
npm run dev   # starts local dev server
# then in another terminal:
curl "http://localhost:8787/__scheduled?cron=0+22+*+*+*"
```

## Tech stack

| Layer | Technology |
|---|---|
| Scraper runtime | Cloudflare Workers + `@cloudflare/puppeteer` |
| AI analysis | Anthropic `claude-3-5-sonnet-latest` via `@anthropic-ai/sdk` |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Email | Resend API |
| Dashboard | Next.js 16 (App Router) on Cloudflare Pages via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + `@tailwindcss/typography` |
| Markdown render | `react-markdown` |
