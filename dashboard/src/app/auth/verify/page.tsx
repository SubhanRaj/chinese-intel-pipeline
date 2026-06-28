import { redirect } from 'next/navigation';
import VerifyForm from './VerifyForm';

export const metadata = {
	title: 'Sign in',
};

export default async function VerifyPage({
	searchParams,
}: {
	searchParams: Promise<{ token?: string }>;
}) {
	const params = await searchParams;
	if (!params.token) redirect('/login');

	return (
		<main className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4 py-16">
			<div className="w-full max-w-sm">
				<div className="mb-8 text-center">
					<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-2">
						Intelligence Monitor
					</p>
					<h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
						Complete sign in
					</h1>
					<p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
						Click the button to verify your identity
					</p>
				</div>

				<div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm p-6">
					<VerifyForm token={params.token} />
				</div>

				<p className="text-center text-xs text-slate-400 dark:text-slate-600 mt-6">
					This link expires after 15 minutes and can only be used once.
				</p>
			</div>
		</main>
	);
}
