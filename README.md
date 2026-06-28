# Chinese Intel Pipeline

An automated intelligence extraction pipeline that scrapes Chinese provincial newspapers every morning, analyses and translates content with Cloudflare Workers AI (Llama 3.3 70B), clusters same-topic stories across sources, and serves structured English briefings through an interactive Next.js dashboard with daily email dispatch.

## Architecture

```
   curl ────────────────────────────────────────► fetch handler
                                                   │ skips if today's feed exists
                                                   │
   cron 30 1 * * * ──────────────────────────────► scheduled handler
                                                   │ skips if today's feed OR briefing exists
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
                                       │  (Sichuan — JS SPA, no coverage)  │
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
                             → temp_articles               (~10–20 articles)
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
                                       │  Resend email (if enabled in UI)      │
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

| Trigger | Idempotency | Use for |
|---|---|---|
| `curl https://scraper-worker…` | Skips if today's `temp_articles` already has data | Fallback / re-run after manual data delete |
| Cron `30 1 * * *` | Skips if today's `temp_articles` OR `intel_briefings` already exists | Production daily run |

Both triggers use the identical fetch engine. No Puppeteer, no Browser Rendering.

**To force a re-run after curl or cron has already run today:**
```bash
npx wrangler d1 execute intel_briefings_db --remote --command \
  "DELETE FROM temp_articles WHERE tracking_date='YYYY-MM-DD'"
# Then curl again
curl https://scraper-worker.shubhanraj2002.workers.dev
```

---

## Fetch Engine — the only scraping layer

Native `fetch()` + `HTMLRewriter` built into the Workers runtime. No npm dependency, no browser, no quota. Six sources have purpose-built dedicated scrapers. Sichuan Daily is a JS SPA with no static article URL pattern — it has no coverage.

### What the fetch engine scrapes

| Source | Scraper | How it works | Yield |
|---|---|---|---|
| **Guangxi Daily** | `scrapeGuangxi()` | Fetches epaper index (`ssw.gxrb.com.cn/json/interface/epaper/api.php?`), extracts article links via `href="?name=gxrb&date=…&code=…&xuhao=…"` pattern, fetches each article | **~8 articles/run** |
| **Hainan Daily** | `scrapeHainan()` | Fetches node page, parses inline JS `l:[…]` array for content file list, fetches each. Two-level: short-text files are section pages → drills one level deeper | **~4–8 articles/run** |
| **Hunan Daily** | `scrapeHunan()` | Fetches `hnrb.hunantoday.cn`, extracts article links matching `/{yyyy}{mm}/` path prefix, fetches each individually. Full body text | **~4–6 articles/run** |
| **Yunnan Daily** | `scrapeYunnan()` | Fetches `www.yndaily.com`, extracts relative `/html/{yyyy}/…` hrefs, fetches each | **~5 articles/run** |
| **Nanfang Daily** | `scrapeNanfang()` | Fetches `epaper.southcn.com/nfdaily/html/{yyyymm}/{dd}/node_A01.html`, extracts absolute `epaper.nfnews.com/…/content_*.html` links, fetches each | **~6 articles/run** |
| **Fujian Daily** | `scrapeFujian()` | Fetches `fjrb.fjdaily.com/pc/col/{yyyymm}/{dd}/node_01.html`, resolves relative `../../../con/{yyyymm}/{dd}/content_*.html` links, fetches each | **~6 articles/run** |
| **Sichuan Daily** | — | JS-rendered SPA — `fetch()` returns a hollow shell with no article links. No static URL pattern discovered. | **0 articles** |

**Total fetch-engine yield: ~33–40 full-text articles from 6 of 7 sources per run.**

Sichuan Daily is the only gap. Adding a dedicated scraper requires finding a static article URL pattern (epaper or static HTML mirror). Jina Reader (`r.jina.ai`) renders it correctly but adds an external dependency.

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
| AI Pass 1 | 1 |
| AI Pass 2 | 1 |
| **Total** | **~44 / 50** |

---

## Two-pass AI pipeline

**Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Cloudflare Workers AI — free tier)
**Neuron budget:** ~10,000 neurons/day free. Each run uses ~700–1,200 neurons — safe for 8–14 runs/day. Not a meaningful bottleneck; the old constraint was Puppeteer's 10 min/day browser cap (removed 2026-06-27).

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

Chinese characters tokenise ~1:1 in Llama 3.3. The 10,000-char input budget keeps input below ~8,000 tokens. Never set `max_tokens` + expected input above ~23,500.

### Pass 2 — Cluster

Groups same-topic articles from different newspapers into one cluster with a synthesised headline and combined assessment. Pass 2 failure is non-fatal — the pipeline falls back to single-item clusters and still saves all intel_articles.

**Output:**
```json
{
  "title": "Synthesised headline drawing on all sources' angles",
  "summary": "2–3 sentence synthesis.",
  "category": "Political | ...",
  "article_indices": [0, 2]
}
```

Every article appears in exactly one cluster. Standalone unique articles form single-element clusters.

**Input cap:** article list serialised to JSON, sliced at 12,000 chars (was 4,000 — caused clustering to fail when 16 articles × ~300 chars exceeded the old limit, silently dropping indices and triggering the fallback).

### Response format handling

Workers AI returns two envelope shapes depending on whether `max_tokens` is set:

| Condition | Shape |
|---|---|
| Default (no `max_tokens`) | `{ response: string }` |
| With `max_tokens` | OpenAI-compat `{ choices: [{ message: { content: string } }] }` |

Both shapes handled by `extractAiText()`. If a pass fails to parse valid JSON, a fallback fires: Pass 1 treats all articles as important with stub analysis; Pass 2 treats each article as its own cluster.

### Pipeline resilience

- **temp_articles is cleared AFTER AI Pass 1 succeeds**, not before. If Pass 1 fails, the previous day's feed is preserved until the next successful run.
- **Pass 2 failure is non-fatal.** If clustering fails, each article becomes its own single-item cluster and all intel data is still saved.
- **All scrape and AI steps wrapped in try-catch** with console.error logging. Failed runs log the error and return a message without crashing the Worker.

---

## Three-tier article storage

| Tier | Table | Content | Duration |
|---|---|---|---|
| **Feed** | `temp_articles` | All scraped articles — title + importance reason (both important and not) | ~24h — cleared after next successful AI Pass 1 |
| **Briefing** | `intel_articles` + `intel_clusters` | Important articles, fully analysed and clustered | 30 days → auto-cleanup |
| **Preserved** | `intel_articles` (`is_preserved=1`) | Hand-preserved articles | Permanent |

URLs stored for ALL articles — `temp_articles.url` links to original Chinese source for every article including non-important ones.

---

## Dashboard

### Today's Feed
All ~33–40 scraped articles grouped by source newspaper, collapsed by default. Click any source header to expand its articles.
- **✓ green** — AI flagged as important; full analysis; appears in Intel Briefing
- **— grey** — AI skipped; title translated only; source URL still available
- One-sentence AI reasoning for every decision (why included or excluded)

### Intel Briefing
One card per cluster. Multiple articles from different papers → one card with "N sources" badge. Cluster drawer shows each source's own translated title, summary, English translation, 中文 toggle, and source URL.

### Archive (Preserved)
Articles bookmarked via the preserve button. Exempt from 30-day cleanup. Visible to signed-in users only (hidden from anonymous).

### Search
Sidebar search. Enter/Search commits query and opens a results page across all dates. Clears back to previous view.

### Sidebar controls
- **Dark/light mode toggle** — persisted in `localStorage` (no flash on refresh — inline script in `<head>` applies dark class before first paint). Available to all users including anonymous.
- **Auth footer** — anonymous users see a Sign in button; signed-in users see their name, role, an Admin link (admin only), and Sign out. Logout redirects to briefing home.
- **Daily email toggle** — per-user on/off, visible to any signed-in user. Updates `users.email_notifications` for the current user. Admin cannot override a user's preference.
- **GitHub link** — links to repository from sidebar footer

---

## Email

Daily briefings via **Resend**. Table-based HTML template (inline CSS — required for Gmail). One row per cluster.

**Current behaviour:** Per-user subscription. Scraper queries `users WHERE email_notifications = 1` and sends the briefing to each address. Users toggle their own subscription from the dashboard sidebar (`setMyEmailEnabled` server action). Admin can see subscription status in `/admin` but cannot override a user's choice — only sets the default (on) at account creation. `settings.email_enabled` and `RESEND_TO_EMAIL` are no longer used.

**Secrets on scraper worker:** `RESEND_API_KEY` ✓, `RESEND_FROM_EMAIL` ✓ (`RESEND_TO_EMAIL` deprecated — not used)
**Secrets on dashboard worker:** `RESEND_API_KEY` ✓, `RESEND_FROM_EMAIL` ✓ (`onboarding@resend.dev`), `SESSION_SECRET` ✓

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
| Sichuan Daily | Sichuan | ❌ JS SPA — `fetch()` returns hollow shell; no static article URL pattern |

---

## Database schema

### `temp_articles` — all scraped articles, ~24h lifespan

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
| `cluster_id` | INTEGER | FK → intel_clusters; backfilled after Pass 2 |
| `parse_type` | TEXT | `'full'` = complete body text |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_clusters` — one row per story cluster

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT | YYYY-MM-DD, CST |
| `title` | TEXT | Synthesised English headline |
| `summary` | TEXT | Combined multi-source assessment |
| `category` | TEXT | Political / Military / Economic / Technology / Social / Foreign Affairs |
| `sources` | TEXT | JSON array of source paper names |
| `created_at` | TEXT | `datetime('now')` default |

### `intel_briefings` — daily parent record

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `tracking_date` | TEXT UNIQUE | YYYY-MM-DD, CST |
| `raw_scraped_text` | TEXT | Concatenated source text |
| `ai_analysis_markdown` | TEXT | `'articles'` sentinel for new runs; legacy Markdown for old data |
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
| `parse_type` | TEXT | `'full'` = complete body text |
| `created_at` | TEXT | `datetime('now')` default |

### `settings` — pipeline configuration

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | Setting name |
| `value` | TEXT | Setting value |

Current keys: `email_enabled` — deprecated, no longer used. Email is now fully per-user via `users.email_notifications`.

### `users` — registered accounts (migration 0009 — deployed)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `email` | TEXT UNIQUE | login identity |
| `name` | TEXT | display name |
| `role` | TEXT | `'admin'` or `'user'` |
| `email_notifications` | INTEGER | `0` = off, `1` = on |
| `created_at` | DATETIME | auto |

### `auth_magic_links` — one-time login tokens (migration 0009 — deployed)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `email` | TEXT | recipient |
| `token_hash` | TEXT | SHA-256 of the plaintext token — never stored raw |
| `expires_at` | TEXT | 15 min from generation |
| `used` | INTEGER | `1` after first verification |
| `created_at` | DATETIME | auto |

### `auth_sessions` — active login sessions (migration 0009 — deployed)

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `crypto.randomUUID()` — HMAC-signed in cookie, verified on each request |
| `user_id` | INTEGER | FK → users |
| `expires_at` | TEXT | admin: never (session cookie handles expiry); user: +1 year |
| `persistent` | INTEGER | `0` = session cookie (admin), `1` = persistent cookie (user) |
| `created_at` | DATETIME | auto |

---

## Security & Auth

### Access tiers (live — migration 0009 deployed)

| Tier | Login | Session | Capabilities |
|---|---|---|---|
| **Anonymous** | None | — | View briefings, feed; toggle dark mode |
| **User** | Magic link (email) | Persistent cookie (1 year) | + preserve articles; toggle own email notifications |
| **Admin** | Magic link | Session cookie (clears on browser/tab close) | + delete articles/clusters; manage users via `/admin` panel |

**Magic link flow (passwordless):** Enter email on `/login` → server checks `users` table → Resend delivers a one-time login URL (15-min expiry, single-use, token hash stored in D1) → click link → session cookie set → redirect to `/`.

**Admin panel (`/admin`):** Pipeline stats (briefings, articles, email sub count), source breakdown, user list with read-only email sub status (users control their own), add/remove users, dark/light/system theme toggle. Plain Tailwind — same CSS tokens and patterns as main app.

**Scraper protection (not yet enabled):** HTTP trigger will require `Authorization: Bearer <SCRAPER_SECRET>`. Cron trigger is already protected by CF scheduler. `SCRAPER_SECRET` secret not yet set.

### Protections

| Surface | Protection |
|---|---|
| Server Actions | All mutations call `requireAuth('user')` or `requireAuth('admin')` before executing |
| Server Actions | Input validated server-side; `deleteArticle` re-checks `is_preserved = 0`; batch cluster actions validate every ID |
| Session cookies | HMAC-SHA256 signed; session ID stored as SHA-256 hash in D1 — plaintext never persisted |
| Magic link tokens | SHA-256 hash stored in D1; plaintext only exists in the emailed URL |
| URL rendering | All `href` values pass through `safeUrl()` — only `http://` and `https://` allowed |
| Content rendering | Article text rendered as React text nodes, never `dangerouslySetInnerHTML` |
| Secrets | All Wrangler secrets — never in source or git |

No third-party auth service (Clerk, Auth0, etc.) — auth is custom-built on CF primitives + SubtleCrypto.

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
│   │   ├── 0006_temp_articles_cluster_id.sql
│   │   ├── 0007_add_url_to_temp_articles.sql
│   │   ├── 0008_add_settings.sql
│   │   └── 0009_add_auth.sql            users, auth_magic_links, auth_sessions
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
│   │   │   ├── fetchAndParseSources()   Runs all 6 dedicated scrapers in parallel via Promise.allSettled
│   │   │   ├── extractAiText()          Handles both Workers AI response envelopes
│   │   │   ├── extractJsonArray()       Finds best JSON array in raw AI text
│   │   │   ├── filterAndAnalyseWithAI() Pass 1 — combined filter + analysis (title + 250-char snippet)
│   │   │   ├── clusterArticlesWithAI()  Pass 2 — cross-source story grouping (input sliced at 12k chars)
│   │   │   ├── sendEmail()              Resend + table-layout HTML (mobile Gmail safe)
│   │   │   └── runPipeline()            Orchestrator; isCron flag controls idempotency depth
│   │   └── db/schema.ts                 Drizzle ORM schema (temp_articles, intel_*, users)
│   └── wrangler.jsonc                   AI + D1 bindings; cron 30 1 * * * (no BROWSER binding)
└── dashboard/
    ├── public/
    │   └── favicon.svg
    ├── src/
    │   ├── app/
    │   │   ├── actions.ts               Server actions: preserve/delete/logout; setMyEmailEnabled
    │   │   ├── layout.tsx               Metadata, fonts, inline dark-mode script (beforeInteractive — no FOUC)
    │   │   ├── page.tsx                 Server component — queries all tables + active session
    │   │   ├── globals.css              Tailwind v4 + @custom-variant dark (&:is(.dark, .dark *))
    │   │   ├── login/                   Magic-link request page + requestMagicLink server action
    │   │   ├── auth/verify/             Magic-link landing page; consumeToken → session cookie
    │   │   └── admin/                   User mgmt panel (plain Tailwind, same tokens as main app)
    │   │                                list/add/remove users; roles; read-only email sub status
    │   ├── components/
    │   │   ├── IntelViewer.tsx          Client: sidebar (email toggle, auth footer, GitHub),
    │   │   │                                    Today's Feed (collapsible by source),
    │   │   │                                    Intel Briefing, ClusterCard, ClusterDrawer, search
    │   │   ├── ThemeToggle.tsx          Shared dark/light/system toggle; works across briefing + admin
    │   │   ├── MarkdownRenderer.tsx     Legacy briefings (react-markdown, ssr:false)
    │   │   └── ui/                      Shadcn primitives
    │   ├── lib/
    │   │   └── auth.ts                  getSession, requireAuth, createSession, deleteSession
    │   └── db/schema.ts                 Drizzle ORM (all tables incl. users, auth_magic_links, auth_sessions)
    └── wrangler.jsonc                   Worker-mode deploy
```

---

## Setup & deployment

### Prerequisites

- Cloudflare account with Workers, D1, and Workers AI enabled
- Node.js 18+
- `npx wrangler login`

### 1. Create D1 database and apply all migrations

```bash
npx wrangler d1 create intel_briefings_db
# Copy the returned database_id into both wrangler.jsonc files, then:
cd scraper-worker
npx wrangler d1 migrations apply intel_briefings_db --remote
```

### 2. Set Worker secrets

**Scraper worker** (`cd scraper-worker`):

```bash
npx wrangler secret put RESEND_API_KEY      # Resend API key for briefing emails
npx wrangler secret put RESEND_FROM_EMAIL   # Verified sender address in Resend
npx wrangler secret put SCRAPER_SECRET      # Bearer token to protect the HTTP trigger
```

**Dashboard worker** (`cd dashboard`):

```bash
npx wrangler secret put SESSION_SECRET      # Random 32+ char string for HMAC session signing
npx wrangler secret put RESEND_API_KEY      # Same Resend key — used for magic-link auth emails
npx wrangler secret put RESEND_FROM_EMAIL   # Verified sender address
```

> Email subscriptions are **per-user** — each user toggles from the sidebar. Default for new users: subscribed. There is no global on/off switch.

### 3. Seed the first admin account

After deploying (step 4), run the auth migration which seeds your admin row, or insert manually:

```bash
npx wrangler d1 execute intel_briefings_db --remote --command \
  "INSERT OR IGNORE INTO users (email, name, role) VALUES ('you@example.com', 'Your Name', 'admin')"
```

Sign in at `/login` — a magic link will be emailed to you.

### 4. Deploy

```bash
cd scraper-worker && npm run deploy
cd ../dashboard && npm run deploy
```

### 5. Test the pipeline (manual trigger)

```bash
curl -H "Authorization: Bearer $SCRAPER_SECRET" \
  https://scraper-worker.shubhanraj2002.workers.dev
```

The response body describes what happened (`Pipeline completed for YYYY-MM-DD — N important articles in M clusters.`). The daily cron at **01:30 UTC** (09:30 CST) runs automatically via Cloudflare's scheduler.

If today's data already exists, the pipeline skips and returns a message. To force a re-run:

```bash
npx wrangler d1 execute intel_briefings_db --remote --command \
  "DELETE FROM temp_articles WHERE tracking_date='$(date +%Y-%m-%d)'"
```

---

## Production URLs

| Service | URL |
|---|---|
| Dashboard | `https://intel-pipeline.shubhanraj2002.workers.dev` |
| Scraper worker (HTTP trigger) | `https://scraper-worker.shubhanraj2002.workers.dev` |
| GitHub | `https://github.com/SubhanRaj/chinese-intel-pipeline` |

---

## Tech stack

| Layer | Technology |
|---|---|
| Scraper | Native `fetch()` + `HTMLRewriter` (CF Workers runtime) — no browser, no npm dependency |
| AI Pass 1 — filter + analyse | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — filter + full analysis in one call |
| AI Pass 2 — clustering | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — cross-source story grouping |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Auth | Custom magic-link + HMAC-signed sessions (CF SubtleCrypto, no third-party auth) |
| Email | Resend API — inline-CSS HTML template (Gmail-compatible) |
| Dashboard | Next.js 16 App Router via `@opennextjs/cloudflare` |
| Styling | Tailwind CSS v4 + Shadcn UI — plain Tailwind throughout (no DaisyUI) |
| Fonts | DM Serif Display + Inter + Geist Mono via `next/font/google` |
| Icons | Tabler Icons |
