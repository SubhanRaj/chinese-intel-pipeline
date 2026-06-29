# Chinese Intel Pipeline — Roadmap

Complete picture of what's shipped, what's planned, what's been considered and set aside, and every gap identified in the codebase. Kept up to date so the project can grow without losing context.

---

## What's Live

### Pipeline & Scraping
- **6 provincial newspaper scrapers** (Guangxi, Hainan, Hunan, Yunnan, Nanfang, Fujian) — fetch engine only, no Puppeteer
- **Cron trigger** — daily at 09:30 CST (`30 1 * * *` UTC) via Cloudflare cron
- **HTTP trigger** — manual re-run via `curl` (idempotent; skips if today's data exists)
- **Two-pass AI pipeline** using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
  - Pass 1: filter (important/not) + full English analysis per article
  - Pass 2: cluster related stories across sources into synthesised topics
- **Pipeline resilience** — `temp_articles` cleared only after Pass 1 succeeds; Pass 2 failure is non-fatal (falls back to single-item clusters); all steps wrapped in try/catch
- **Subrequest budget discipline** — ~44 fetch calls per run, well within the 50/invocation free-tier limit

### Database (D1 / SQLite)
- `temp_articles` — raw 24h feed, auto-cleared after next successful Pass 1
- `intel_clusters` — AI-grouped topic clusters with synthesised title + source list
- `intel_articles` — fully analysed articles with English translation, Chinese source text, category, importance flag, preserve flag
- `intel_briefings` — parent record per day with AI markdown + email status
- `users` — invited accounts with role (`admin` | `user`) and per-user email preference
- `auth_magic_links` — one-time login tokens (hashed, 15-min expiry)
- `auth_sessions` — active sessions (hashed session ID, admin sessions ephemeral)
- `settings` — legacy key-value store (no longer used for email)
- 30-day auto-cleanup on `intel_clusters` + `intel_articles`; preserved articles (`is_preserved = 1`) exempt

### Dashboard (Next.js on Cloudflare)

**Three main views:**
- **Intel Briefing** — clustered important articles by date; multi-source stories show N-sources badge and per-source drawer
- **Today's Feed** — all ~33–40 raw scraped articles grouped by source; AI reasoning shown per article; links to originals
- **Preserved Archive** — bookmarked articles exempt from 30-day cleanup; searchable

**Reading experience:**
- Font family (10 options — Inter, Space Grotesk, DM Serif, Lora, Merriweather, Playfair, Crimson, Bitter, Geist Mono, JetBrains; loaded on demand from Google Fonts)
- Font size (XS → XL), line height (Compact → Spacious), reading width (Narrow → Wide)
- Accent color (5 presets: red, blue, amber, emerald, violet)
- Dark / light / system theme toggle — no FOUC (inline `beforeInteractive` script)
- All prefs in `localStorage` key `intel-reading-prefs-v1`; applied before first paint
- Customization panel: floating FAB (bottom-right), iOS safe-area aware, auto-hides on scroll/drawer open, `pointer-events-none` wrapper so it never blocks scroll

**Content metadata:**
- Category tags with color coding (Political, Military, Economic, Technology, Social, Foreign Affairs)
- HIGH importance flag from AI
- Multi-source cluster indicator (N-sources badge)
- Parse type badge (RSS vs. full-text)
- Source attribution (which newspaper)
- Original URL link on every article (temp + intel)
- Chinese source text toggle in article drawer
- Full English translations available per article in drawer

**Mobile & PWA:**
- Swipe-right to close drawers (both `ClusterDrawer` and `ArticleDrawer`; 60px threshold, 1.5× H:V ratio so vertical scroll never triggers it)
- Sticky "← Back" button in drawers (`sm:hidden`)
- `manifest.json` with `display:standalone`, 192×192 + 512×512 icons
- Network-first service worker (`public/sw.js`) — Chrome install prompt; never serves stale auth pages from cache
- iOS `appleWebApp` meta + `apple-touch-icon`
- Page transitions: pure CSS fade (no translateY), sidebar always closed on mount on mobile

**Search:**
- Global search across all briefing dates (title, summary, source, category)
- Per-view search within selected date

### Auth & Security
- **Three-tier access:** Anonymous (read-only) → User (preserve + email toggle) → Admin (delete + manage users)
- **Magic link** passwordless login — token hashed (SHA-256) in D1; plaintext only in email link; single-use, 15-min expiry
- **Sessions** — `crypto.randomUUID()` signed with HMAC-SHA256; stored as hash in D1; admin sessions have no `Max-Age` (ephemeral); user sessions 1-year persistent
- **All mutations** (`togglePreserve`, `deleteArticle`, `deleteCluster`, `setMyEmailEnabled`) call `requireAuth()` — unauthenticated calls rejected at the server action layer
- No third-party auth providers — built entirely on CF primitives (SubtleCrypto + D1 + Resend)
- Session revocation via logout (deletes D1 row)

### Email
- Daily briefing email via Resend API
- Recipients: all `users WHERE email_notifications = 1` — fully per-user, no global kill-switch
- Users toggle own subscription from the customization FAB (`setMyEmailEnabled` server action)
- Scraper has its own separate `RESEND_API_KEY` (distinct from dashboard's key)

### Admin Panel (`/admin`)
- Pipeline stats: briefing count, intel article count, today's feed count, email subscriber count
- Source breakdown: articles scraped per newspaper (all-time)
- User table: name, email, role, email sub status (read-only)
- Add new user (name, email, role; email sub defaults on)
- Remove user (cannot remove self; cannot remove sole admin)
- Shared `ThemeToggle` component — same `localStorage` key as main app
- Plain Tailwind with same CSS tokens as main app (no DaisyUI)

---

## Data Available But Not Yet Surfaced

These fields exist in the database and are populated on every run but have no UI representation yet. Low-hanging fruit when the time is right.

- **`rawScrapedText` in `intel_briefings`** — full concatenated text of all articles for the day. Used only as AI context internally; never shown. Could power a raw source audit trail or side-by-side comparison view.
- **`aiAnalysisMarkdown` in `intel_briefings`** — structured AI summary of the briefing. UI shows it only when not equal to `'articles'`; in practice almost never triggered. Could be a "daily summary" card at the top of the briefing.
- **`emailStatus` in `intel_briefings`** — 0/1 flag for whether email was sent. Not shown anywhere in admin. No retry mechanism exposed.
- **Parse type details** — RSS vs. full-text is shown as a tiny badge but never used as a filter. No stats on RSS coverage vs. full coverage per source.
- **`intel_clusters.sources` JSON array** — used to compute multi-source badge but not filterable. No way to show "only stories where both Yunnan and Guangxi reported".
- **Article creation timestamps** — indexed but invisible in UI. Could show freshness or import sequence.
- **`fullText` (Chinese)** — available via toggle in drawer but not searchable and not indexed for full-text search.
- **`fullTextEn` (English translation)** — available in drawer but not used in briefing card preview. No metadata on translation completeness.

---

## Planned Features

### High Priority

**Category & source filter chips**
Filter chips above the briefing feed — Political, Military, Economic, Technology, Social, Foreign Affairs — and per-source newspaper toggles. Data is already tagged on every article; pure UI change, no schema needed. Biggest daily-use UX improvement.

**Article count badges on sidebar dates**
Show `(12)` next to each date in the sidebar. One extra field in the page query. Immediately signals which days had significant coverage vs. thin runs. Also useful when deciding which archive date to open.

**Scraper status panel in `/admin`**
Table showing `source → articles scraped today` vs. expected count (~6–9 per source). Surfaces silent scraper failures without needing to check Cloudflare logs. Zero new infra — reads from `temp_articles` counts grouped by source. Each row shows: source name, expected count, actual count, status indicator (ok / low / missing).

**~~`SCRAPER_SECRET` on HTTP trigger~~** ✅ Done (2026-06-29)
Secret set; hard-fail 401 when missing (no soft guard); constant-time XOR comparison. Cron bypasses the check (CF-internal).

### Medium Priority

**Story timeline view**
When viewing a cluster, show previous briefing dates where the same topic appeared — a "this story across dates" trail. Lets you track how a story evolves day over day or week over week. Implementation: keyword similarity search across `intel_clusters.synthesised_title` grouped by `tracking_date`. No new AI calls needed. The highest intelligence-value feature on the list — turns daily snapshots into a continuous thread.

**Date-range + multi-filter search**
Combine search term + date range + category filter into one query. D1 supports compound WHERE clauses; mainly a UI + query layer update. Turns the archive into a proper intelligence database. Suggested UI: search box + date pickers + category chips all on one search page.

**Export preserved articles**
"Export my archive" button — generates a Markdown or JSON file of all the user's preserved articles (English analysis, cluster context, source URL, tracking date, category). Runs as a server action streaming a file download. No new infra. Useful for users who want to take their bookmarks into another tool.

**Read / unread tracking**
New `user_reads` table (`user_id`, `cluster_id`, `read_at`). Unread badges on sidebar dates; bold or dot-marked unread clusters in the briefing feed. Small schema addition (one migration), meaningful UX improvement for users who check the dashboard daily and want to know what's new since their last visit.

**Manual scraper trigger from `/admin`**
Button in the admin panel that POSTs to the scraper worker URL with the `SCRAPER_SECRET` header. Optionally add a "force re-run" checkbox that deletes today's `temp_articles` before triggering. Removes the need to SSH/curl manually for a force re-run. Shows trigger status and response inline.

**Email delivery status in `/admin`**
Surface the existing `intel_briefings.emailStatus` flag in a table column next to each briefing date. Add a "Retry" button that re-sends the email for a given date. Requires no new schema — just exposing data that already exists.

### Lower Priority / Nice to Have

**RSS / Atom feed output**
Public `/feed.xml` endpoint — one item per cluster, English summary, link back to dashboard briefing. Generated on-demand from `intel_clusters`. No auth required. Lets anyone subscribe in any feed reader without an account. Useful if the project ever goes more public.

**Keyboard shortcuts**
`j` / `k` to navigate articles, `/` to focus search, `p` to preserve current article, `Esc` to close drawer, `?` to show shortcut reference. Standard reader UX (similar to Reeder, NetNewsWire). No backend changes — pure client JS.

**"New since last visit" indicator**
Store last-visited timestamp in `localStorage`. On return, show a subtle banner: "3 new briefings since your last visit." Highlight new dates in the sidebar. Pure client-side, no backend, no schema changes.

**Bulk preserve / delete**
Checkbox multi-select on articles for batch operations. Admin-only for delete; user role for preserve. Mainly a UI concern — batched server action that accepts an array of article IDs. Useful when doing archive cleanup or bulk-bookmarking a day's articles.

**Briefing header card**
Show a short AI-generated "today in brief" card at the top of the Intel Briefing view — 3–4 bullet points summarising the most significant themes of the day. `aiAnalysisMarkdown` in `intel_briefings` exists for this purpose but is currently unused. Would require the scraper to populate this field more reliably.

**"New since last visit" email digest option**
Instead of (or in addition to) the daily email, let users opt for a "weekly digest" — one email per week summarising the 5 most important clusters. Controlled from the customization FAB with the same `setMyEmailEnabled` pattern. New field on `users` table: `email_frequency` (`daily` | `weekly` | `off`).

**Source reliability / coverage stats**
Per-source panel showing: average articles per run, scraper failure rate (days where count was 0 or < threshold), parse type breakdown (RSS vs. full-text). Historical — aggregated from `temp_articles` data. Gives a sense of which sources are most reliable over time.

**Print / PDF export of a briefing**
"Print this briefing" button that renders a clean print stylesheet — no sidebar, no customization panel, just the clusters in a readable format. Could also generate a PDF via the browser's native print-to-PDF. No backend needed.

**Article ingestion log**
Per-run log visible in `/admin` showing: run timestamp, articles scraped per source, AI Pass 1 results (how many flagged important), Pass 2 clustering result (how many clusters formed), email send status. Stored as a new `pipeline_runs` table or as JSON in `intel_briefings`. Currently only visible in Cloudflare Worker logs (not persisted).

**Sorting options**
Toggle sort order in the briefing feed: newest-first (default), by category, by importance score, by source count. Client-side sort on the already-loaded data — no additional queries.

**Hover preview on sidebar dates**
When hovering a date in the sidebar, show a tooltip/popover with the top 3 cluster titles for that day. Requires passing cluster summaries alongside the date list in the page query.

**"Read next" / related articles**
At the bottom of an article drawer, suggest related articles from the same cluster, same category, or same source. Could be purely client-side (filter already-loaded data) or a lightweight D1 query.

**In-app notifications**
When a new briefing is ready (detected by comparing latest `tracking_date` to last-seen date in `localStorage`), show a non-intrusive in-app banner: "Today's briefing is ready." No backend needed — just polling on focus/visibility change.

**Annotation on preserved articles**
Let users add a short personal note to a preserved article. New `user_article_notes` table (`user_id`, `article_id`, `note TEXT`, `created_at`). Shown below the article in the preserved archive view. Notes stay even if the article is later un-preserved and re-preserved.

**Cluster quality feedback**
Thumbs up / down on clusters to signal AI clustering quality. Stored in a `cluster_feedback` table. Admin can see aggregate feedback in `/admin`. Over time, feedback could be used to tune the clustering prompt.

---

## Considered & Set Aside

**Sichuan Daily scraper**
The site is a JS SPA with no static article URL pattern. Would require Browser Rendering (Puppeteer), which was intentionally removed 2026-06-27. The subrequest budget is also nearly full (~44/50). No coverage for now — 0 subrequests allocated. Revisit only if a static mirror or API is found, or if subrequest budget is freed up elsewhere.

**Story relationship graph / knowledge graph**
Visually connecting articles and clusters across dates with a graph view. High intelligence value but needs a vector store or more complex AI calls — too heavy for the current Workers AI budget (10k neurons/day) and Cloudflare free-tier constraints. Revisit if the project moves to a paid AI tier.

**Category trend analysis / time-series charts**
"Political stories up 40% this month" style metrics with charts. Interesting but requires aggregation queries that could be slow on D1 at scale, plus a charting library in the frontend. Revisit if briefing volume grows and a charting lib is already in the dependency tree.

**Google OAuth for admin login**
OAuth2 via fetch calls only (no SDK, needs GCP project setup). Nice alternative to magic link for admin but adds external dependency and setup overhead. Magic link works fine for the current single-admin setup. Revisit if multiple admins need onboarding or if magic link delivery becomes unreliable.

**Public signup flow**
Open registration beyond invited accounts. Not in scope — this is an invite-only intelligence tool. If the project ever opens to a wider audience, would need rate limiting, email verification, and role assignment workflow.

**Push / desktop notifications**
Would require a web push service, VAPID key management, and a subscription store in D1. Adds meaningful operational complexity. Email covers the daily digest use case adequately for the current user count.

**Slack / Teams webhook integration**
Post daily briefing summary to a Slack channel or Teams space. Adds an external dependency and operational surface. Low priority until there are more users with that workflow need. Could be implemented as a simple webhook POST alongside the email send in the scraper worker.

**Third-party auth (Clerk, Auth0, Supabase Auth)**
Explicitly out of scope. Auth is custom-built on CF primitives and SubtleCrypto — no external auth provider will be added. This keeps the project dependency-free and entirely on Cloudflare's stack.

**DaisyUI**
Removed entirely (caused dark mode conflicts with the custom CSS token system). All UI uses plain Tailwind with project-defined tokens. Not coming back.

**Per-user inline highlights on article text**
Let users highlight specific sentences in an article. Would need a range-selection UI, a way to serialise text ranges, and a storage table. Scope-creep for current use case — annotations at the article level (see "Annotation on preserved articles" above) cover the main need.

**Image / media support**
Source newspapers include photos and diagrams. Fetching and storing images would require R2 (Cloudflare object storage), image resizing, and significant scraper changes. Articles are text-only for now; adding images would also bloat the AI context window.

**Manual article injection**
Admin-only UI to manually add an article (URL + title + body) that wasn't scraped. Would need a separate "manual" source type, schema changes, and an input form. Low priority — the pipeline covers the target sources well.

**RSS full-text fallback**
Some feed sources return only summaries. Adding a secondary fetch to retrieve full article text for RSS-only articles would consume extra subrequests (already near budget) and complicate the scraper. Accepted limitation for now.

**Translation quality / confidence scoring**
Show a confidence score or flag next to AI-translated English text. Workers AI doesn't expose token-level confidence; would require a separate validation pass — an extra AI call that costs subrequests and neurons.

---

## Architecture Constraints (never break these)

- **50 subrequests / invocation** — current budget: ~44. Don't add fetch calls without removing others.
- **10,000 neurons / day (Workers AI free tier)** — ~700–1,200 per run; ~8–14 runs/day headroom. Not a real bottleneck in practice but don't add extra AI passes without checking.
- **AI context window** — 24,000 tokens total. Pass 1 input ~7,600 tokens + 14,000 max_tokens = ~21,600. Never set max_tokens + expected input > 23,500.
- **AI model** — always `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Never downgrade to a smaller model.
- **No BROWSER binding** — Puppeteer removed intentionally 2026-06-27. All scraping is fetch-only.
- **No third-party auth providers** — custom auth only (SubtleCrypto + D1 + Resend).
- **No DaisyUI** — plain Tailwind + project CSS tokens.
- **No `dangerouslySetInnerHTML`** anywhere in the dashboard.
- **Internal navigation** — always `<Link>` (Next.js), never `<a href>`. Plain anchors force a full page reload, lose React state, and cause a visible flash.
- **Auth on all mutations** — every server action that writes must call `requireAuth()` before executing.
- **Secrets in D1 always hashed** — session IDs and tokens stored as SHA-256, never plaintext.
- **Admin sessions ephemeral** — no `Max-Age` on admin session cookies; must clear on browser/tab close.
- **Email is per-user** — `settings.email_enabled` global kill-switch is gone; do not bring it back. Scraper reads `users WHERE email_notifications = 1` directly.
- **temp_articles DELETE stays after AI Pass 1** — not before. Moving it back to before the AI call breaks the resilience guarantee (failed AI call would leave feed empty until next run).
- **Don't expose `RESEND_TO_EMAIL`** — scraper reads recipient list from D1, not from a secret. `RESEND_TO_EMAIL` is no longer used.
- **Secrets are bound to worker name** — if a worker is renamed or recreated, secrets do not carry over. Re-apply manually with `wrangler secret put`.
