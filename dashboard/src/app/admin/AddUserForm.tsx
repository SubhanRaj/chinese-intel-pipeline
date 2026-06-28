'use client';

import { useState, useTransition, useRef } from 'react';

interface Props {
	addUser: (formData: FormData) => Promise<{ error?: string }>;
}

const inputClass = 'w-full px-3 py-2.5 text-base rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400 transition-colors';
const labelClass = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5';

export default function AddUserForm({ addUser }: Props) {
	const [error, setError] = useState('');
	const [success, setSuccess] = useState(false);
	const [pending, startTransition] = useTransition();
	const formRef = useRef<HTMLFormElement>(null);

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError('');
		setSuccess(false);
		const formData = new FormData(e.currentTarget);
		startTransition(async () => {
			const result = await addUser(formData);
			if (result.error) {
				setError(result.error);
			} else {
				setSuccess(true);
				formRef.current?.reset();
			}
		});
	};

	return (
		<form ref={formRef} onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
			<div>
				<label htmlFor="add-name" className={labelClass}>Name</label>
				<input id="add-name" type="text" name="name" required placeholder="Full name" className={inputClass} />
			</div>
			<div>
				<label htmlFor="add-email" className={labelClass}>Email</label>
				<input id="add-email" type="email" name="email" required placeholder="user@example.com" className={inputClass} />
			</div>
			<div>
				<label htmlFor="add-role" className={labelClass}>Role</label>
				<select id="add-role" name="role" defaultValue="user" className={inputClass}>
					<option value="user">User</option>
					<option value="admin">Admin</option>
				</select>
			</div>
			<div className="flex items-end">
				<button
					type="submit"
					disabled={pending}
					className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-base font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/50"
				>
					{pending ? 'Adding…' : 'Add user'}
				</button>
			</div>
			{error && (
				<div className="sm:col-span-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg px-4 py-3">
					{error}
				</div>
			)}
			{success && (
				<div className="sm:col-span-2 text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-lg px-4 py-3">
					User added successfully.
				</div>
			)}
		</form>
	);
}
