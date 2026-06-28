import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import LoginForm from './LoginForm';

export const metadata = {
	title: 'Sign in',
};

export default async function LoginPage() {
	const session = await getSession();
	if (session) redirect('/');

	return (
		<main className="min-h-dvh flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4 py-8 sm:py-16 overflow-y-auto">
			<div className="w-full max-w-sm">
				<div className="mb-8 text-center">
					<p className="text-sm font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-2">
						Intelligence Monitor
					</p>
					<h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-100">
						Chinese Provincial Press
					</h1>
					<p className="text-base text-slate-500 dark:text-slate-400 mt-2">
						Sign in to access your dashboard
					</p>
				</div>

				<div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-6">
					<LoginForm />
				</div>

				<p className="text-center text-sm text-slate-400 dark:text-slate-600 mt-6">
					Access is by invitation only. Contact the administrator to request access.
				</p>
			</div>
		</main>
	);
}
