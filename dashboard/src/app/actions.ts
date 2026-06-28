'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';

import { intelArticles, settings } from '@/db/schema';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAuth, deleteSession } from '@/lib/auth';
import { users } from '@/db/schema';

export async function logout(): Promise<void> {
	await deleteSession();
	redirect('/');
}

function validId(id: unknown): id is number {
	return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

export async function togglePreserve(id: number, current: number) {
	await requireAuth('user');
	if (!validId(id)) return;
	if (current !== 0 && current !== 1) return;
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	await db.update(intelArticles).set({ isPreserved: current ? 0 : 1 }).where(eq(intelArticles.id, id));
	revalidatePath('/');
}

export async function unpreserveAndDelete(id: number) {
	await requireAuth('admin');
	if (!validId(id)) return;
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	await db.update(intelArticles).set({ isPreserved: 0 }).where(eq(intelArticles.id, id));
	await db.delete(intelArticles).where(eq(intelArticles.id, id));
	revalidatePath('/');
}

export async function togglePreserveCluster(ids: number[], currentlyPreserved: boolean) {
	await requireAuth('user');
	if (!ids.length || !ids.every(validId)) return;
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	const next = currentlyPreserved ? 0 : 1;
	for (const id of ids) {
		await db.update(intelArticles).set({ isPreserved: next }).where(eq(intelArticles.id, id));
	}
	revalidatePath('/');
}

export async function deleteCluster(ids: number[]) {
	await requireAuth('admin');
	if (!ids.length || !ids.every(validId)) return;
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	for (const id of ids) {
		const rows = await db.select({ isPreserved: intelArticles.isPreserved }).from(intelArticles).where(eq(intelArticles.id, id)).limit(1);
		if (!rows.length || rows[0].isPreserved) continue;
		await db.delete(intelArticles).where(eq(intelArticles.id, id));
	}
	revalidatePath('/');
}

export async function setMyEmailEnabled(enabled: boolean) {
	const session = await requireAuth('user');
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	await db.update(users).set({ emailNotifications: enabled ? 1 : 0 }).where(eq(users.id, session.id));
	revalidatePath('/');
}

export async function deleteArticle(id: number) {
	await requireAuth('admin');
	if (!validId(id)) return;
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	const rows = await db.select({ isPreserved: intelArticles.isPreserved }).from(intelArticles).where(eq(intelArticles.id, id)).limit(1);
	if (!rows.length || rows[0].isPreserved) return;
	await db.delete(intelArticles).where(eq(intelArticles.id, id));
	revalidatePath('/');
}
