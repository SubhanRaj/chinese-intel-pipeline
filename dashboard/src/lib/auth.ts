import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authSessions, users } from '@/db/schema';

const COOKIE_NAME = 'intel-session';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionUser = {
	id: number;
	email: string;
	name: string;
	role: 'admin' | 'user';
};

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function sha256hex(data: string): Promise<string> {
	const buf = new TextEncoder().encode(data);
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

async function hmacSign(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

async function hmacVerify(data: string, sig: string, secret: string): Promise<boolean> {
	const expected = await hmacSign(data, secret);
	if (expected.length !== sig.length) return false;
	// Constant-time comparison to prevent timing attacks
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
	}
	return diff === 0;
}

/** SHA-256 hash a magic-link token before storing in D1. */
export async function hashToken(token: string): Promise<string> {
	return sha256hex(token);
}

// ── Session management ────────────────────────────────────────────────────────

/** Read and verify the session cookie. Returns null if missing, invalid, or expired. */
export async function getSession(): Promise<SessionUser | null> {
	const cookieStore = await cookies();
	const cookie = cookieStore.get(COOKIE_NAME)?.value;
	if (!cookie) return null;

	const dotIdx = cookie.lastIndexOf('.');
	if (dotIdx < 0) return null;
	const rawId = cookie.slice(0, dotIdx);
	const sig = cookie.slice(dotIdx + 1);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const secret: string = env.SESSION_SECRET ?? '';
	if (!secret) return null; // Secret not configured

	const valid = await hmacVerify(rawId, sig, secret);
	if (!valid) return null;

	const sessionHash = await sha256hex(rawId);
	const db = drizzle(env.DB);

	const rows = await db
		.select({
			sessionId: authSessions.id,
			expiresAt: authSessions.expiresAt,
			userId: authSessions.userId,
			email: users.email,
			name: users.name,
			role: users.role,
		})
		.from(authSessions)
		.innerJoin(users, eq(users.id, authSessions.userId))
		.where(eq(authSessions.id, sessionHash))
		.limit(1);

	const row = rows[0] ?? null;
	if (!row) return null;

	if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
		await db.delete(authSessions).where(eq(authSessions.id, sessionHash));
		return null;
	}

	return {
		id: row.userId,
		email: row.email,
		name: row.name,
		role: row.role as 'admin' | 'user',
	};
}

/** Throw a redirect to /login if not authenticated, or to / if wrong role. */
export async function requireAuth(minRole: 'user' | 'admin' = 'user'): Promise<SessionUser> {
	const session = await getSession();
	if (!session) redirect('/login');
	if (minRole === 'admin' && session.role !== 'admin') redirect('/');
	return session;
}

/**
 * Create a new session in D1. Returns the signed cookie value to be set by
 * the caller (server action or route handler) — never stored or exposed plaintext.
 *
 * Admin sessions: persistent=false (ephemeral, clears on browser close).
 * User sessions: persistent=true (1-year cookie).
 */
export async function createSession(userId: number, persistent: boolean): Promise<string> {
	const rawId = crypto.randomUUID();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };

	const [sessionHash, sig] = await Promise.all([
		sha256hex(rawId),
		hmacSign(rawId, env.SESSION_SECRET as string),
	]);

	const cookieValue = `${rawId}.${sig}`;
	const expiresAt = persistent
		? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
		: null;

	const db = drizzle(env.DB);
	await db.insert(authSessions).values({
		id: sessionHash,
		userId,
		expiresAt,
		persistent: persistent ? 1 : 0,
	});

	return cookieValue;
}

/** Delete the current session from D1 and remove the cookie. */
export async function deleteSession(): Promise<void> {
	const cookieStore = await cookies();
	const cookie = cookieStore.get(COOKIE_NAME)?.value;

	if (cookie) {
		const dotIdx = cookie.lastIndexOf('.');
		if (dotIdx >= 0) {
			const rawId = cookie.slice(0, dotIdx);
			const sessionHash = await sha256hex(rawId);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const { env } = await getCloudflareContext({ async: true }) as { env: any };
			const db = drizzle(env.DB);
			await db.delete(authSessions).where(eq(authSessions.id, sessionHash));
		}
	}

	cookieStore.delete(COOKIE_NAME);
}

/** Cookie options for setting the session cookie. */
export function sessionCookieOptions(persistent: boolean): Record<string, unknown> {
	return {
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		path: '/',
		...(persistent ? { maxAge: 365 * 24 * 60 * 60 } : {}),
	};
}
