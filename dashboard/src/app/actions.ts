'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { intelArticles } from '@/db/schema';
import { revalidatePath } from 'next/cache';

function validId(id: unknown): id is number {
	return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

export async function togglePreserve(id: number, current: number) {
	if (!validId(id)) return;
	// current must be exactly 0 or 1
	if (current !== 0 && current !== 1) return;

	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	await db
		.update(intelArticles)
		.set({ isPreserved: current ? 0 : 1 })
		.where(eq(intelArticles.id, id));
	revalidatePath('/');
}

/** Removes the preservation lock and immediately deletes the article in one operation. */
export async function unpreserveAndDelete(id: number) {
	if (!validId(id)) return;

	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	// Clear the lock first so the delete is not blocked by any future guard
	await db.update(intelArticles).set({ isPreserved: 0 }).where(eq(intelArticles.id, id));
	await db.delete(intelArticles).where(eq(intelArticles.id, id));
	revalidatePath('/');
}

/** Preserve or unpreserve every article in a cluster in one action. */
export async function togglePreserveCluster(ids: number[], currentlyPreserved: boolean) {
	if (!ids.length || !ids.every(validId)) return;

	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	const next = currentlyPreserved ? 0 : 1;
	for (const id of ids) {
		await db.update(intelArticles).set({ isPreserved: next }).where(eq(intelArticles.id, id));
	}
	revalidatePath('/');
}

/** Delete all non-preserved articles in a cluster. Preserved ones are silently skipped. */
export async function deleteCluster(ids: number[]) {
	if (!ids.length || !ids.every(validId)) return;

	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	for (const id of ids) {
		const rows = await db
			.select({ isPreserved: intelArticles.isPreserved })
			.from(intelArticles)
			.where(eq(intelArticles.id, id))
			.limit(1);
		if (!rows.length || rows[0].isPreserved) continue;
		await db.delete(intelArticles).where(eq(intelArticles.id, id));
	}
	revalidatePath('/');
}

export async function deleteArticle(id: number) {
	if (!validId(id)) return;

	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);

	// Server-side preservation guard — never delete a preserved article
	const rows = await db
		.select({ isPreserved: intelArticles.isPreserved })
		.from(intelArticles)
		.where(eq(intelArticles.id, id))
		.limit(1);

	if (!rows.length || rows[0].isPreserved) return;

	await db.delete(intelArticles).where(eq(intelArticles.id, id));
	revalidatePath('/');
}
