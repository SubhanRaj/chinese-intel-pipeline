'use client';

import { useState, useTransition } from 'react';
import { requestMagicLink } from './actions';

type Step = 'email' | 'sent';

export default function LoginForm() {
	const [step, setStep] = useState<Step>('email');
	const [email, setEmail] = useState('');
	const [error, setError] = useState('');
	const [pending, startTransition] = useTransition();

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		setError('');
		startTransition(async () => {
			const result = await requestMagicLink(email);
			if (result.error) {
				// Generic message check: if the error looks like a success message
				// (email-exists check returns generic text), still show the sent state
				if (result.error.includes('has been sent')) {
					setStep('sent');
				} else {
					setError(result.error);
				}
				return;
			}
			setStep('sent');
		});
	};

	if (step === 'sent') {
		return (
			<div className="text-center space-y-4">
				<div className="text-4xl">✉️</div>
				<div>
					<p className="font-semibold text-slate-900 dark:text-slate-100 text-base">Check your inbox</p>
					<p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
						We sent a sign-in link to <strong className="text-slate-700 dark:text-slate-300">{email}</strong>
					</p>
				</div>
				<p className="text-xs text-slate-400 dark:text-slate-500">
					The link expires in 15 minutes. Check your spam folder if you don&apos;t see it.
				</p>
				<button
					type="button"
					onClick={() => { setStep('email'); setError(''); }}
					className="text-sm text-red-600 dark:text-red-400 hover:underline"
				>
					Use a different email
				</button>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div>
				<label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
					Email address
				</label>
				<input
					id="email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={e => setEmail(e.target.value)}
					placeholder="you@example.com"
					className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400 transition-colors"
				/>
			</div>

			{error && (
				<p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg px-3 py-2">
					{error}
				</p>
			)}

			<button
				type="submit"
				disabled={pending || !email}
				className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900 text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/50"
			>
				{pending ? 'Sending…' : 'Send sign-in link'}
			</button>
		</form>
	);
}
