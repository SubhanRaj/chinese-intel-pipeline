import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import { asc } from 'drizzle-orm';
import { users } from '@/db/schema';
import { getSession } from '@/lib/auth';
import { addUser, removeUser, toggleUserEmail } from './actions';
import AddUserForm from './AddUserForm';

export default async function AdminPage() {
	const session = await getSession();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { env } = await getCloudflareContext({ async: true }) as { env: any };
	const db = drizzle(env.DB);
	const allUsers = await db.select().from(users).orderBy(asc(users.createdAt));

	return (
		<div className="max-w-4xl mx-auto px-4 py-10">

			{/* Header */}
			<div className="flex items-center justify-between mb-8">
				<div>
					<p className="text-sm font-bold tracking-widest uppercase text-red-600 mb-1">Admin Panel</p>
					<h1 className="text-3xl font-bold">User Management</h1>
					<p className="text-base opacity-60 mt-0.5">Signed in as {session!.name} · {session!.email}</p>
				</div>
				<a href="/" className="btn btn-ghost btn-md">← Dashboard</a>
			</div>

			{/* Stats */}
			<div className="stats shadow mb-8 w-full">
				<div className="stat">
					<div className="stat-title text-base">Total users</div>
					<div className="stat-value">{allUsers.length}</div>
				</div>
				<div className="stat">
					<div className="stat-title text-base">Admins</div>
					<div className="stat-value">{allUsers.filter(u => u.role === 'admin').length}</div>
				</div>
				<div className="stat">
					<div className="stat-title text-base">Email subs</div>
					<div className="stat-value">{allUsers.filter(u => u.emailNotifications).length}</div>
				</div>
			</div>

			{/* User table */}
			<div className="card bg-base-100 shadow mb-8">
				<div className="card-body p-0">
					<table className="table table-zebra text-base">
						<thead>
							<tr>
								<th>Name</th>
								<th>Email</th>
								<th>Role</th>
								<th>Emails</th>
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
										<form action={toggleUserEmail.bind(null, u.id, u.emailNotifications ?? 0)}>
											<button
												type="submit"
												className={`toggle toggle-md ${u.emailNotifications ? 'toggle-success' : ''}`}
												title={u.emailNotifications ? 'Disable email notifications' : 'Enable email notifications'}
											/>
										</form>
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
