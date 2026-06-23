import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { desc } from 'drizzle-orm';
import { intelBriefings } from '@/db/schema';
import IntelViewer from '@/components/IntelViewer';

export const dynamic = 'force-dynamic';

export default async function Home() {
	const { env } = await getCloudflareContext({ async: true });
	const db = drizzle(env.DB);

	const briefings = await db
		.select()
		.from(intelBriefings)
		.orderBy(desc(intelBriefings.trackingDate));

	return <IntelViewer briefings={briefings} />;
}
