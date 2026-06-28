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

## Database: four tiers (current)

| Table | Content | Lifetime |
|---|---|---|
| `temp_articles` | All scraped articles (important + not), 24h feed | Cleared after next successful AI Pass 1 |
| `intel_clusters` + `intel_articles` | Important articles, fully analysed and clustered | 30 days → auto-cleanup |
| `intel_articles` where `is_preserved=1` | Hand-preserved articles | Permanent |
| `settings` | Legacy pipeline config (no longer used for email) | Persistent key-value store |
| `users` | Known accounts with per-user email preference | Permanent |
| `auth_magic_links` | One-time login tokens | Auto-expired (15 min) |
| `auth_sessions` | Active sessions | Until logout or cookie expiry |

**URLs are stored for ALL articles** including non-important ones in `temp_articles.url`. The dashboard shows a ↗ source link on every card.

**Auth tables (migration 0009 — deployed):**

| Table | Content |
|---|---|
| `users` | Known accounts: `id, email, name, role ('admin'|'user'), email_notifications, created_at` |
| `auth_magic_links` | One-time login tokens: `id, email, token_hash, expires_at, used, created_at` |
| `auth_sessions` | Active sessions: `id TEXT (UUID), user_id, expires_at, persistent (0=session/1=remember), created_at` |

## Key files

```
scraper-worker/src/index.ts       — all pipeline logic (scraping, AI, storage, email)
scraper-worker/wrangler.jsonc     — bindings (D1, AI), cron 30 1 * * * (no BROWSER binding)
scraper-worker/migrations/        — D1 schema migrations 0001–0009 (0009 auth — deployed)
dashboard/src/app/page.tsx        — server component, queries all tables + session
dashboard/src/components/IntelViewer.tsx — client UI (sidebar, feed, briefing, auth footer; no email toggle)
dashboard/src/components/CustomizationPanel.tsx — floating FAB: font/size/spacing/width/accent/email (client-only, ssr:false)
dashboard/src/app/actions.ts      — server actions (preserve/delete article & cluster; setMyEmailEnabled; logout)
dashboard/src/app/layout.tsx      — inline script in <head>: dark-mode + reading prefs (beforeInteractive — no FOUC)
dashboard/src/app/globals.css     — accent color system (--ui-accent, .text-accent, .bg-accent) + reading CSS vars
dashboard/src/db/schema.ts        — Drizzle ORM schema (all tables)
dashboard/src/lib/auth.ts         — session helpers: getSession, requireAuth, createSession, deleteSession
dashboard/src/app/login/          — magic-link request page + requestMagicLink server action
dashboard/src/app/auth/verify/    — magic-link landing page; consumeToken verifies token + sets session cookie
dashboard/src/app/admin/          — user management panel (admin role only); plain Tailwind, same tokens as main app
dashboard/src/components/ThemeToggle.tsx — shared dark/light/system toggle; used on briefing + admin pages
```

## Dashboard features

- **Today's Feed** — all scraped articles grouped by source newspaper, collapsed by default. Click source header to expand. AI reasoning shown for every article.
- **Intel Briefing** — clustered important articles. Multi-source stories → one card with N-sources badge and per-source drawer.
- **Archive (Preserved)** — bookmarked articles, exempt from 30-day cleanup.
- **Search** — sidebar search across all dates.
- **Dark mode** — persisted in `localStorage`. Inline `<Script strategy="beforeInteractive">` in layout.tsx adds `dark` class to `<html>` before first paint — no flash on refresh.
- **Customization panel** — floating FAB (bottom-right). Collapsed by default; auto-hides on article drawer open or scroll. Contains: font family (10 options, Google Fonts loaded on demand with loading spinner + button lock), font size, line spacing, reading width, accent color (5 presets). Email toggle also lives here — visible to signed-in users only. All prefs stored in `localStorage` key `intel-reading-prefs-v1`; size/spacing/width/accent applied before first paint via the `beforeInteractive` inline script.
- **GitHub link** — sidebar footer.
- **Auth footer** — bottom of sidebar shows signed-in user (name + role) with Admin and Sign out links; anonymous users see a Sign in button. Logout redirects to `/` (briefing home).
- **Admin panel** — pipeline stats (briefings, articles, today's feed, email sub count), source breakdown, user table with read-only email sub status, add/remove users. Dark/light/system theme toggle in header uses same `localStorage` key as main app.

## Auth & Security (migration 0009 — deployed)

### Access tiers

| Tier | Who | Login method | What they can do |
|---|---|---|---|
| Anonymous | Everyone | — | View briefings, feed, toggle dark mode |
| User | Invited user | Magic link (email) | Everything above + preserve articles + toggle own email notifications |
| Admin | Subhan | Magic link + optional TOTP | Everything above + delete articles/clusters + manage users via `/admin` panel |

### Magic link flow (passwordless)
1. Enter email on `/login` → server checks `users` table → if found, generates a signed one-time token (HMAC-SHA256, UUID, stored hashed in D1, 15-min expiry)
2. Resend delivers a link: `https://dashboard.../auth/verify?token=<token>`
3. Click link → token verified (single-use, expiry checked) → session created
4. Admin with TOTP configured: intermediate TOTP challenge before session is issued
5. Session cookie set: admin gets a session cookie (no `Max-Age` → clears on browser/tab close); users get a 1-year persistent cookie

### Session security
- Session ID: `crypto.randomUUID()` — HMAC-SHA256 signed in cookie value, verified on each request
- Session stored in D1 `auth_sessions`; can be revoked by deleting the row (logout)
- All tokens and session IDs stored as SHA-256 hashes in D1, never plaintext
- All mutations (`togglePreserve`, `deleteArticle`, `deleteCluster`, etc.) call `requireAuth()` before executing
- Magic link token hash: SHA-256 in D1. Plaintext token only exists in the email link and in-browser URL — never stored

### Scraper protection (planned)
- New `SCRAPER_SECRET` CF secret on the scraper worker
- HTTP GET trigger: requires `Authorization: Bearer <SCRAPER_SECRET>` header
- Cron trigger: bypasses check (internal, already protected by CF)
- `curl` invocations updated to: `curl -H "Authorization: Bearer $SCRAPER_SECRET" <url>`

### Secrets status
- Dashboard worker: `SESSION_SECRET` ✓, `RESEND_API_KEY` ✓, `RESEND_FROM_EMAIL` ✓ (`onboarding@resend.dev`)
- Scraper worker: `RESEND_API_KEY` ✓, `RESEND_FROM_EMAIL` ✓ — `RESEND_TO_EMAIL` no longer used; `SCRAPER_SECRET` not yet set (GET trigger is unprotected)

### Email subscriptions (live)
- Scraper queries `users WHERE email_notifications = 1` and sends briefing to all matching email addresses
- `settings.email_enabled` and `RESEND_TO_EMAIL` are no longer used — fully per-user now
- Users control their own subscription from the customization panel FAB (`setMyEmailEnabled` server action)
- Admin can see subscription status in `/admin` but cannot override a user's preference
- Default for new users: `email_notifications = 1` (subscribed)

### Admin panel capabilities (live at `/admin`)
- Pipeline stats: briefing count, intel article count, today's feed count, email sub count
- Source breakdown: articles scraped per newspaper (all time)
- List all users (name, email, role, email sub status — read-only)
- Add new user: set name, email, role (email sub defaults to on)
- Remove user (cannot remove self; cannot remove sole admin)
- Dark/light/system theme toggle via shared `ThemeToggle` component — same `localStorage` key as main app
- UI uses plain Tailwind with same CSS tokens/patterns as main app (no DaisyUI)

### Future (not in current scope)
- Public signup flow (multi-user beyond invited accounts)
- Google OAuth as admin alternate login (OAuth2 via fetch calls only, no SDK — needs GCP project)
- Per-user article annotations beyond bookmarks

## Things to never do

- Don't bump article fetch caps without checking total subrequest count (target ≤ 48).
- Don't add a new fetch call in the hot path without removing one elsewhere.
- Don't change the AI model to something smaller — use `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Don't set `max_tokens` > (24000 − expected_input_tokens − 500). Current safe ceiling is 14,000.
- Don't add a BROWSER binding back — Puppeteer was removed 2026-06-27 intentionally.
- Don't use `dangerouslySetInnerHTML` anywhere in the dashboard.
- Don't commit `.env` or Wrangler secrets to git — stored as Wrangler secrets only.
- Don't move the temp_articles DELETE back to before the AI call — it was intentionally moved after Pass 1 to preserve feed data on AI failures.
- Don't expose auth tokens or session IDs in plaintext in D1 — always store as SHA-256 hashes.
- Don't add a 3rd-party auth provider (Clerk, Auth0, etc.) — auth is custom-built using CF primitives and SubtleCrypto.
- Don't allow mutations (preserve, delete, email toggle) without calling `requireAuth()` — all server actions must check session.
- Don't set `Max-Age` on admin session cookies — admin sessions must be ephemeral (clear on browser close).
- Don't add DaisyUI back — it was removed entirely (caused dark mode conflicts). Admin page uses plain Tailwind with the same tokens as the rest of the app.
- Don't add back a global `settings.email_enabled` kill-switch — email is now fully per-user via `users.email_notifications`. The `settings` table is kept but no longer used for email.
- Don't allow admin to toggle another user's `email_notifications` — only the user themselves can change their own subscription (enforced in `setMyEmailEnabled` via `requireAuth` + session user ID).
- Don't use `RESEND_TO_EMAIL` — scraper reads recipient list directly from D1 `users` table.

## Deploy commands

```bash
# Scraper worker
cd scraper-worker && npm run deploy

# Dashboard
cd dashboard && npm run deploy

# Test the pipeline (skips if today's data already exists)
curl https://scraper-worker.shubhanraj2002.workers.dev

# After SCRAPER_SECRET is set, test with:
curl -H "Authorization: Bearer $SCRAPER_SECRET" https://scraper-worker.shubhanraj2002.workers.dev

# Force re-run (delete today's feed first)
npx wrangler d1 execute intel_briefings_db --remote --command \
  "DELETE FROM temp_articles WHERE tracking_date='$(date +%Y-%m-%d)'"

# Check D1 data
cd scraper-worker && npx wrangler d1 execute intel_briefings_db --remote --command "SELECT ..."

# Set secrets (run once per worker after auth migration)
cd scraper-worker && npx wrangler secret put SCRAPER_SECRET
cd dashboard && npx wrangler secret put SESSION_SECRET
cd dashboard && npx wrangler secret put RESEND_API_KEY
cd dashboard && npx wrangler secret put RESEND_FROM_EMAIL

# Run auth migration (0009)
npx wrangler d1 execute intel_briefings_db --remote \
  --file scraper-worker/migrations/0009_add_auth.sql
```
