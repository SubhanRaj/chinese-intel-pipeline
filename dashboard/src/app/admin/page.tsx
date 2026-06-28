import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { asc, count, eq } from 'drizzle-orm';
import { users, intelBriefings, intelArticles, tempArticles } from '@/db/schema';
import { getSession } from '@/lib/auth';
import { addUser, removeUser, revokeUserSessions } from './actions';
import AddUserForm from './AddUserForm';
import ThemeToggle from '@/components/ThemeToggle';

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

	const stats = [
		{ label: 'Briefings',     value: totalBriefings, sub: `Last: ${lastRun}` },
		{ label: 'Intel articles', value: totalArticles,  sub: `${preservedArticles} preserved` },
		{ label: "Today's feed",  value: todayFeedCount,  sub: today },
		{ label: 'Email subs',    value: emailSubCount,   sub: 'subscribed users' },
	];

	return (
		<main className="min-h-screen bg-slate-50 dark:bg-slate-950 px-4 py-12">
		<div className="max-w-5xl mx-auto space-y-8">

			{/* Header — same pattern as login/verify pages */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-1">
						Intelligence Monitor
					</p>
					<h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-100">
						Admin Panel
					</h1>
					<p className="text-base text-slate-500 dark:text-slate-400 mt-1">
						Signed in as {session!.name} · {session!.email}
					</p>
				</div>
				<div className="flex items-center gap-2 sm:mt-1 shrink-0">
					<ThemeToggle />
					<a
						href="/"
						className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
					>
						← Dashboard
					</a>
				</div>
			</div>

			{/* Pipeline Stats */}
			<section>
				<p className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 mb-3">
					Pipeline Stats
				</p>
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
					{stats.map(s => (
						<div key={s.label} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-5">
							<p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{s.label}</p>
							<p className="text-3xl font-bold text-slate-900 dark:text-slate-100">{s.value}</p>
							<p className="text-xs text-slate-400 dark:text-slate-600 mt-1 font-mono">{s.sub}</p>
						</div>
					))}
				</div>
			</section>

			{/* Source breakdown */}
			{sources.length > 0 && (
				<section className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-6">
					<p className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 mb-4">
						Articles by source · all time
					</p>
					<div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
						{sources.map(s => (
							<div key={s.source} className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2 border border-slate-100 dark:border-slate-800">
								<span className="text-sm font-medium text-slate-700 dark:text-slate-300">{s.source}</span>
								<span className="text-sm font-bold text-slate-400 dark:text-slate-500 font-mono">{s.cnt}</span>
							</div>
						))}
					</div>
				</section>
			)}

			{/* Users */}
			<section>
				<p className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 mb-3">
					Users
				</p>
				<div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden mb-2">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
								<th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Name</th>
								<th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Email</th>
								<th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Role</th>
								<th
									className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide cursor-help"
									title="Set by each user from their own sidebar — admin cannot override."
								>
									Email ⓘ
								</th>
								<th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Joined</th>
								<th className="px-5 py-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100 dark:divide-slate-800">
							{allUsers.map(u => (
								<tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
									<td className="px-5 py-3.5 font-medium text-slate-900 dark:text-slate-100">{u.name}</td>
									<td className="px-5 py-3.5 font-mono text-slate-600 dark:text-slate-400 text-xs">{u.email}</td>
									<td className="px-5 py-3.5">
										<span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${
											u.role === 'admin'
												? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
												: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
										}`}>
											{u.role}
										</span>
									</td>
									<td className="px-5 py-3.5">
										<span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${
											u.emailNotifications
												? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
												: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500'
										}`}>
											{u.emailNotifications ? 'on' : 'off'}
										</span>
									</td>
									<td className="px-5 py-3.5 font-mono text-xs text-slate-400 dark:text-slate-600">
										{u.createdAt ? u.createdAt.slice(0, 10) : '—'}
									</td>
									<td className="px-5 py-3.5">
										<div className="flex items-center gap-3">
											<form action={revokeUserSessions.bind(null, u.id)}>
												<button
													type="submit"
													className="text-xs font-medium text-amber-600 dark:text-amber-500 hover:text-amber-800 dark:hover:text-amber-300 hover:underline transition-colors"
													title="Sign out all active sessions for this user"
												>
													Revoke sessions
												</button>
											</form>
											{u.email !== session!.email && (
												<form action={removeUser.bind(null, u.id)}>
													<button
														type="submit"
														className="text-xs font-medium text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:underline transition-colors"
													>
														Remove
													</button>
												</form>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="text-xs text-slate-400 dark:text-slate-600">
					ⓘ Email is user-controlled — each user toggles from their own sidebar. Default for new users: on.
				</p>
			</section>

			{/* Add user */}
			<section className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-6">
				<p className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 mb-5">
					Add user
				</p>
				<AddUserForm addUser={addUser} />
			</section>

		</div>
		</main>
	);
}
