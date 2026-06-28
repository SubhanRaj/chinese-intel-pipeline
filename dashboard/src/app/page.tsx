import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { desc, eq } from 'drizzle-orm';
import { intelBriefings, intelArticles, intelClusters, tempArticles, users } from '@/db/schema';
import IntelViewer from '@/components/IntelViewer';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);

	const [briefings, articles, clusters, feed, session] = await Promise.all([
		db.select().from(intelBriefings).orderBy(desc(intelBriefings.trackingDate)),
		db.select().from(intelArticles).orderBy(desc(intelArticles.createdAt)),
		db.select().from(intelClusters).orderBy(desc(intelClusters.createdAt)),
		db.select().from(tempArticles).orderBy(desc(tempArticles.createdAt)),
		getSession(),
	]);

	// Email enabled = this user's per-user preference (null/false for anonymous)
	let emailEnabled = false;
	if (session) {
		const userRow = await db.select({ emailNotifications: users.emailNotifications })
			.from(users).where(eq(users.id, session.id)).limit(1);
		emailEnabled = (userRow[0]?.emailNotifications ?? 0) === 1;
	}

	return (
		<IntelViewer
			briefings={briefings}
			articles={articles}
			clusters={clusters}
			feed={feed}
			emailEnabled={emailEnabled}
			userRole={session?.role ?? null}
			userName={session?.name ?? null}
		/>
	);
}
