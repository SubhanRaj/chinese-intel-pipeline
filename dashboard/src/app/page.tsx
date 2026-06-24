import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { desc } from 'drizzle-orm';
import { intelBriefings, intelArticles, intelClusters, tempArticles } from '@/db/schema';
import IntelViewer from '@/components/IntelViewer';

export const dynamic = 'force-dynamic';

export default async function Home() {
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);

	const [briefings, articles, clusters, feed] = await Promise.all([
		db.select().from(intelBriefings).orderBy(desc(intelBriefings.trackingDate)),
		db.select().from(intelArticles).orderBy(desc(intelArticles.createdAt)),
		db.select().from(intelClusters).orderBy(desc(intelClusters.createdAt)),
		db.select().from(tempArticles).orderBy(desc(tempArticles.createdAt)),
	]);

	return <IntelViewer briefings={briefings} articles={articles} clusters={clusters} feed={feed} />;
}
