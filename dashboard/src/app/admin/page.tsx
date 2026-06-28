import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { asc, count, eq } from 'drizzle-orm';
import { users, intelBriefings, intelArticles, tempArticles } from '@/db/schema';
import { getSession } from '@/lib/auth';
import { addUser, removeUser } from './actions';
import AddUserForm from './AddUserForm';
import ThemeToggle from './ThemeToggle';

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
		env.DB.prepare(`
			SELECT source, COUNT(*) as cnt
			FROM intel_articles
			GROUP BY source
			ORDER BY cnt DESC
		`).all() as Promise<{ results: { source: string; cnt: number }[] }>,
		db.select({ trackingDate: intelBriefings.trackingDate }).from(intelBriefings)
			.orderBy(asc(intelBriefings.trackingDate)).limit(999),
	]);

	const emailSubCount = allUsers.filter(u => u.emailNotifications).length;
	const sources: { source: string; cnt: number }[] = sourceRows.results ?? [];
	const lastRun = latestBriefing.at(-1)?.trackingDate ?? '—';

	return (
		<div className="max-w-5xl mx-auto px-4 py-10">

			{/* Header */}
			<div className="flex items-start justify-between mb-8">
				<div>
					<p className="text-sm font-bold tracking-widest uppercase text-red-600 mb-1">Admin Panel</p>
					<h1 className="text-3xl font-bold">User Management</h1>
					<p className="text-base opacity-60 mt-0.5">Signed in as {session!.name} · {session!.email}</p>
				</div>
				<div className="flex items-center gap-2 mt-1">
					<ThemeToggle />
					<a href="/" className="btn btn-ghost btn-sm">← Dashboard</a>
				</div>
			</div>

			{/* ── Pipeline Stats ─────────────────────────────────────────────── */}
			<h2 className="text-lg font-semibold mb-3 opacity-70">Pipeline Stats</h2>
			<div className="stats stats-horizontal shadow mb-4 w-full">
				<div className="stat">
					<div className="stat-title">Briefings</div>
					<div className="stat-value text-2xl">{totalBriefings}</div>
					<div className="stat-desc">Last run: {lastRun}</div>
				</div>
				<div className="stat">
					<div className="stat-title">Intel articles</div>
					<div className="stat-value text-2xl">{totalArticles}</div>
					<div className="stat-desc">{preservedArticles} preserved</div>
				</div>
				<div className="stat">
					<div className="stat-title">Today&apos;s feed</div>
					<div className="stat-value text-2xl">{todayFeedCount}</div>
					<div className="stat-desc">scraped articles ({today})</div>
				</div>
				<div className="stat">
					<div className="stat-title">Email subs</div>
					<div className="stat-value text-2xl">{emailSubCount}</div>
					<div className="stat-desc">users subscribed</div>
				</div>
			</div>

			{/* Source breakdown */}
			{sources.length > 0 && (
				<div className="card bg-base-100 shadow mb-8">
					<div className="card-body py-4">
						<h3 className="font-semibold text-base mb-3">Articles by source (all time)</h3>
						<div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
							{sources.map(s => (
								<div key={s.source} className="flex items-center justify-between bg-base-200 rounded-lg px-3 py-2">
									<span className="text-sm font-medium">{s.source}</span>
									<span className="badge badge-neutral badge-sm">{s.cnt}</span>
								</div>
							))}
						</div>
					</div>
				</div>
			)}

			{/* ── User Management ────────────────────────────────────────────── */}
			<h2 className="text-lg font-semibold mb-3 opacity-70">Users</h2>
			<div className="stats stats-horizontal shadow mb-6 w-full">
				<div className="stat">
					<div className="stat-title">Total users</div>
					<div className="stat-value">{allUsers.length}</div>
				</div>
				<div className="stat">
					<div className="stat-title">Admins</div>
					<div className="stat-value">{allUsers.filter(u => u.role === 'admin').length}</div>
				</div>
				<div className="stat">
					<div className="stat-title">Email subs</div>
					<div className="stat-value">{emailSubCount}</div>
					<div className="stat-desc">subscribed to briefings</div>
				</div>
			</div>

			{/* User table */}
			<div className="card bg-base-100 shadow mb-4">
				<div className="card-body p-0">
					<table className="table table-zebra text-base">
						<thead>
							<tr>
								<th>Name</th>
								<th>Email</th>
								<th>Role</th>
								<th title="Controlled by each user from their own sidebar. Admin cannot override — only visible here.">
									Email sub ⓘ
								</th>
								<th>Joined</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{allUsers.map(u => (
								<tr key={u.id}>
									<td className="font-medium">{u.name}</td>
									<td className="font-mono">{u.email}</td>
									<td>
										<span className={`badge badge-md ${u.role === 'admin' ? 'badge-error' : 'badge-ghost'}`}>
											{u.role}
										</span>
									</td>
									<td>
										<span className={`badge badge-md ${u.emailNotifications ? 'badge-success' : 'badge-ghost opacity-50'}`}>
											{u.emailNotifications ? 'on' : 'off'}
										</span>
									</td>
									<td className="font-mono opacity-60">
										{u.createdAt ? u.createdAt.slice(0, 10) : '—'}
									</td>
									<td>
										{u.email !== session!.email && (
											<form action={removeUser.bind(null, u.id)}>
												<button type="submit" className="btn btn-ghost btn-sm text-error">
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
			</div>
			<p className="text-sm opacity-50 mb-8">
				ⓘ Email subscription is user-controlled. Each user toggles it from their own sidebar — admin cannot override it. The default when adding a new user is &ldquo;on&rdquo;. Briefings are sent to all users with it enabled.
			</p>

			{/* Add user form */}
			<div className="card bg-base-100 shadow">
				<div className="card-body">
					<h2 className="card-title text-xl mb-2">Add user</h2>
					<AddUserForm addUser={addUser} />
				</div>
			</div>

		</div>
	);
}
