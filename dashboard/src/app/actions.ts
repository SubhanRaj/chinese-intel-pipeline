'use server';

import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { intelArticles } from '@/db/schema';
import { revalidatePath } from 'next/cache';

export async function togglePreserve(id: number, current: number) {
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	await db
		.update(intelArticles)
		.set({ isPreserved: current ? 0 : 1 })
		.where(eq(intelArticles.id, id));
	revalidatePath('/');
}

export async function deleteArticle(id: number) {
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);
	await db.delete(intelArticles).where(eq(intelArticles.id, id));
	revalidatePath('/');
}
