# Chinese Intel Pipeline — Dashboard

Next.js 16 App Router dashboard deployed as a Cloudflare Worker via `@opennextjs/cloudflare`.

## Stack

- **Framework:** Next.js 16 (App Router)
- **Runtime:** Cloudflare Worker (`@opennextjs/cloudflare`)
- **Database:** Cloudflare D1 via Drizzle ORM
- **Styling:** Tailwind CSS v4 + Shadcn UI (main app) · plain Tailwind (admin panel)
- **Auth:** Custom magic-link passwordless auth (SubtleCrypto + D1 sessions)
- **Email:** Resend (magic link delivery)

## Commands

```bash
npm run dev        # Next.js dev server (local)
npm run preview    # Build + run on local Cloudflare runtime
npm run deploy     # Build + deploy to Cloudflare Workers
```

## Secrets (set via wrangler secret put)

| Secret | Worker | Purpose |
|---|---|---|
| `SESSION_SECRET` | dashboard | HMAC key for signing session cookies |
| `RESEND_API_KEY` | dashboard | Magic link email delivery |
| `RESEND_FROM_EMAIL` | dashboard | Sender address (`onboarding@resend.dev`) |

## Key files

```
src/app/page.tsx              Server component — reads D1, passes data to IntelViewer
src/app/actions.ts            Server actions: preserve/delete/logout/setEmailEnabled
src/app/layout.tsx            Fonts, dark-mode inline script (no FOUC)
src/app/globals.css           Tailwind v4 + Shadcn CSS tokens
src/app/login/                Magic-link request page
src/app/auth/verify/          Magic-link verify page (sets session cookie)
src/app/admin/                User management panel (plain Tailwind, same tokens as main app)
src/components/IntelViewer.tsx  All client UI (sidebar, briefing, feed, search)
src/lib/auth.ts               getSession, requireAuth, createSession, deleteSession
src/db/schema.ts              Drizzle schema (all tables incl. auth)
```

## Auth flow

1. User visits `/login`, enters email
2. Server calls Resend → delivers magic link to inbox
3. User clicks link → `/auth/verify?token=<uuid>`
4. Token verified (single-use, 15-min expiry, hash stored in D1)
5. Session cookie set (admin: ephemeral; user: 1-year persistent)
6. Redirected to `/`

Anonymous users can read all briefings. Authenticated users can preserve articles and toggle their own daily email subscription. Admin can delete, manage users at `/admin`, and see email sub status (read-only — users control their own preference).
