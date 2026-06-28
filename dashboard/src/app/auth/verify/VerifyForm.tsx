'use client';

import { useState, useTransition } from 'react';
import { consumeToken } from './actions';

export default function VerifyForm({ token }: { token: string }) {
	const [error, setError] = useState('');
	const [pending, startTransition] = useTransition();

	const handleVerify = () => {
		setError('');
		startTransition(async () => {
			const result = await consumeToken(token);
			if (result?.error) setError(result.error);
			// On success consumeToken redirects to / — we never reach here
		});
	};

	return (
		<div className="space-y-4">
			<p className="text-sm text-slate-600 dark:text-slate-400">
				Your sign-in link is ready. Click below to complete authentication and access the dashboard.
			</p>

			{error && (
				<p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg px-3 py-2">
					{error}
				</p>
			)}

			<button
				type="button"
				onClick={handleVerify}
				disabled={pending}
				className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900 text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/50"
			>
				{pending ? 'Verifying…' : 'Sign in to Intel Monitor'}
			</button>

			<p className="text-center text-xs text-slate-400 dark:text-slate-500">
				Didn&apos;t request this?{' '}
				<a href="/login" className="text-red-600 dark:text-red-400 hover:underline">
					Go back
				</a>
			</p>
		</div>
	);
}
