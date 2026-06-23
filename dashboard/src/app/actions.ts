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
