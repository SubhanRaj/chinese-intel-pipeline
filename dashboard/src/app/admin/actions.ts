'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/auth';
import { users, authSessions } from '@/db/schema';
import { revalidatePath } from 'next/cache';

function validId(id: unknown): id is number {
	return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

export async function addUser(formData: FormData): Promise<{ error?: string }> {
	await requireAuth('admin');

	const name = (formData.get('name') as string ?? '').trim();
	const email = (formData.get('email') as string ?? '').trim().toLowerCase();
	const role = formData.get('role') as string;

	if (!name || !email || !email.includes('@')) return { error: 'Name and valid email are required.' };
	if (name.length > 100) return { error: 'Name must be 100 characters or fewer.' };
	if (role !== 'admin' && role !== 'user') return { error: 'Invalid role.' };

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);

	try {
		await db.insert(users).values({ name, email, role, emailNotifications: 1 });
	} catch {
		return { error: 'That email address is already registered.' };
	}

	revalidatePath('/admin');
	return {};
}

export async function removeUser(id: number): Promise<void> {
	const session = await requireAuth('admin');
	if (!validId(id)) return;
	// Prevent self-deletion — UI hides the button but the action enforces it too
	if (id === session.id) return;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);

	// Never allow removing the sole admin
	const adminCount = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
	const target = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
	if (target[0]?.role === 'admin' && adminCount.length <= 1) return;

	await db.delete(users).where(eq(users.id, id));
	revalidatePath('/admin');
}

export async function revokeUserSessions(id: number): Promise<void> {
	await requireAuth('admin');
	if (!validId(id)) return;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);
	await db.delete(authSessions).where(eq(authSessions.userId, id));
	revalidatePath('/admin');
}
