import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { asc, count, eq } from 'drizzle-orm';
import { users, intelBriefings, intelArticles, tempArticles } from '@/db/schema';
import { getSession } from '@/lib/auth';
import { addUser, removeUser } from './actions';
import AddUserForm from './AddUserForm';

const card = 'bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800';
const statCard = `${card} p-5`;

export default async function AdminPage() {
	const session = await getSession();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);

	const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

	const [
		allUsers,
		[{ total: totalBriefings }],
		[{ total: totalArticles }],
		[{ total: preservedArticles }],
		[{ total: todayFeedCount }],
		sourceRows,
		latestBriefing,
	] = await Promise.all([
		db.select().from(users).orderBy(asc(users.createdAt)),
		db.select({ total: count() }).from(intelBriefings),
		db.select({ total: count() }).from(intelArticles),
		db.select({ total: count() }).from(intelArticles).where(eq(intelArticles.isPreserved, 1)),
		db.select({ total: count() }).from(tempArticles).where(eq(tempArticles.trackingDate, today)),
		env.DB.prepare(`SELECT source, COUNT(*) as cnt FROM intel_articles GROUP BY source ORDER BY cnt DESC`).all() as Promise<{ results: { source: string; cnt: number }[] }>,
		db.select({ trackingDate: intelBriefings.trackingDate }).from(intelBriefings).orderBy(asc(intelBriefings.trackingDate)).limit(999),
	]);

	const emailSubCount = allUsers.filter(u => u.emailNotifications).length;
	const sources: { source: string; cnt: number }[] = sourceRows.results ?? [];
	const lastRun = latestBriefing.at(-1)?.trackingDate ?? '—';

	return (
		<main className="min-h-screen bg-slate-50 dark:bg-slate-950 px-4 py-10">
		<div className="max-w-5xl mx-auto">

			{/* Header */}
			<div className="flex items-start justify-between mb-10">
				<div>
					<p className="text-sm font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-1">Admin Panel</p>
					<h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Dashboard</h1>
					<p className="text-base text-slate-500 dark:text-slate-400 mt-1">
						Signed in as {session!.name} · {session!.email}
					</p>
				</div>
				<a
					href="/"
					className="mt-1 px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				>
					← Dashboard
				</a>
			</div>

			{/* Pipeline Stats */}
			<h2 className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 mb-3">Pipeline Stats</h2>
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
				{[
					{ label: 'Briefings', value: totalBriefings, sub: `Last: ${lastRun}` },
					{ label: 'Intel articles', value: totalArticles, sub: `${preservedArticles} preserved` },
					{ label: "Today's feed", value: todayFeedCount, sub: today },
					{ label: 'Email subs', value: emailSubCount, sub: 'subscribed users' },
				].map(s => (
					<div key={s.label} className={statCard}>
						<p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{s.label}</p>
						<p className="text-3xl font-bold text-slate-900 dark:text-slate-100">{s.value}</p>
						<p className="text-xs text-slate-400 dark:text-slate-600 mt-1">{s.sub}</p>
					</div>
				))}
			</div>

			{/* Source breakdown */}
			{sources.length > 0 && (
				<div className={`${card} p-5 mb-8`}>
					<h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">Articles by source (all time)</h3>
					<div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
						{sources.map(s => (
							<div key={s.source} className="flex items-center justify-between bg-slate-50 dark:bg-slate-800 rounded-lg px-3 py-2">
								<span className="text-sm font-medium text-slate-700 dark:text-slate-300">{s.source}</span>
								<span className="text-sm font-bold text-slate-500 dark:text-slate-400">{s.cnt}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Users */}
			<h2 className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 mb-3">Users</h2>
			<div className={`${card} mb-2 overflow-hidden`}>
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-slate-200 dark:border-slate-800">
							{['Name', 'Email', 'Role', 'Email sub ⓘ', 'Joined', ''].map(h => (
								<th
									key={h}
									className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide"
									title={h === 'Email sub ⓘ' ? 'Controlled by each user from their sidebar — admin cannot override.' : undefined}
								>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-slate-100 dark:divide-slate-800">
						{allUsers.map(u => (
							<tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
								<td className="px-5 py-3.5 font-medium text-slate-900 dark:text-slate-100">{u.name}</td>
								<td className="px-5 py-3.5 font-mono text-slate-600 dark:text-slate-400">{u.email}</td>
								<td className="px-5 py-3.5">
									<span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
										u.role === 'admin'
											? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
											: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
									}`}>
										{u.role}
									</span>
								</td>
								<td className="px-5 py-3.5">
									<span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
										u.emailNotifications
											? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
											: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500'
									}`}>
										{u.emailNotifications ? 'on' : 'off'}
									</span>
								</td>
								<td className="px-5 py-3.5 font-mono text-slate-500 dark:text-slate-400">
									{u.createdAt ? u.createdAt.slice(0, 10) : '—'}
								</td>
								<td className="px-5 py-3.5">
									{u.email !== session!.email && (
										<form action={removeUser.bind(null, u.id)}>
											<button type="submit" className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400 hover:underline transition-colors">
												Remove
											</button>
										</form>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-xs text-slate-400 dark:text-slate-600 mb-8">
				ⓘ Email subscription is user-controlled. Each user toggles it from their own sidebar. Default for new users: on.
			</p>

			{/* Add user */}
			<div className={`${card} p-6`}>
				<h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-5">Add user</h2>
				<AddUserForm addUser={addUser} />
			</div>

		</div>
		</main>
	);
}
