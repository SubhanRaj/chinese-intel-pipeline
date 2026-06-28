'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authMagicLinks, users } from '@/db/schema';
import { hashToken, createSession, deleteSession, sessionCookieOptions } from '@/lib/auth';
import { sendMagicLinkEmail } from '@/lib/email';
import { revalidatePath } from 'next/cache';

// ── Request magic link ────────────────────────────────────────────────────────

export async function requestMagicLink(email: string): Promise<{ error?: string }> {
	const trimmed = email.trim().toLowerCase();
	if (!trimmed || !trimmed.includes('@')) return { error: 'Please enter a valid email address.' };

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);

	// Only registered users can sign in
	const userRows = await db.select().from(users).where(eq(users.email, trimmed)).limit(1);
	const user = userRows[0] ?? null;
	// Return a generic message regardless — don't reveal whether the email exists
	if (!user) return { error: 'If that email is registered, a sign-in link has been sent.' };

	// Rate limit: delete any existing unused, unexpired links for this email, then create a new one
	await db.delete(authMagicLinks).where(
		and(eq(authMagicLinks.email, trimmed), eq(authMagicLinks.used, 0)),
	);

	// Generate a cryptographically secure random token (UUID — 128 bits entropy)
	const rawToken = crypto.randomUUID();
	const tokenHash = await hashToken(rawToken);
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

	await db.insert(authMagicLinks).values({ email: trimmed, tokenHash, expiresAt, used: 0 });

	// Build verify URL from the actual request host — no hardcoded domain
	const headersList = await headers();
	const host = headersList.get('host') ?? 'localhost:3000';
	const proto = host.includes('localhost') ? 'http' : 'https';
	const verifyUrl = `${proto}://${host}/auth/verify?token=${rawToken}`;

	await sendMagicLinkEmail(trimmed, verifyUrl, user.name);

	return {};
}

// ── Consume magic link token ──────────────────────────────────────────────────

export async function consumeToken(token: string): Promise<{ error?: string }> {
	if (!token || typeof token !== 'string') return { error: 'Invalid request.' };

	const tokenHash = await hashToken(token);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);

	const linkRows = await db
		.select()
		.from(authMagicLinks)
		.where(and(eq(authMagicLinks.tokenHash, tokenHash), eq(authMagicLinks.used, 0)))
		.limit(1);

	const link = linkRows[0] ?? null;

	// Always use generic errors to avoid oracle attacks
	if (!link || new Date(link.expiresAt) < new Date()) {
		// Mark as used if it exists (prevents reuse attempts on expired tokens)
		if (link) await db.update(authMagicLinks).set({ used: 1 }).where(eq(authMagicLinks.id, link.id));
		return { error: 'This sign-in link is invalid or has expired. Please request a new one.' };
	}

	// Consume the token immediately — single use
	await db.update(authMagicLinks).set({ used: 1 }).where(eq(authMagicLinks.id, link.id));

	const userRows = await db.select().from(users).where(eq(users.email, link.email)).limit(1);
	const user = userRows[0] ?? null;
	if (!user) return { error: 'Account not found. Please contact the administrator.' };

	// Admin: ephemeral session (no maxAge — clears on browser close)
	// User: persistent 1-year session
	const persistent = user.role !== 'admin';
	const cookieValue = await createSession(user.id, persistent);

	const cookieStore = await cookies();
	cookieStore.set('intel-session', cookieValue, sessionCookieOptions(persistent) as Parameters<typeof cookieStore.set>[2]);

	revalidatePath('/');
	redirect('/');
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
	await deleteSession();
	redirect('/login');
}
