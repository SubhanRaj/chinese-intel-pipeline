'use client';

import { useState, useTransition, useRef } from 'react';

interface Props {
	addUser: (formData: FormData) => Promise<{ error?: string }>;
}

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
			<div className="form-control">
				<label className="label"><span className="label-text text-base">Name</span></label>
				<input type="text" name="name" required placeholder="Full name" className="input input-bordered input-md text-base" />
			</div>
			<div className="form-control">
				<label className="label"><span className="label-text text-base">Email</span></label>
				<input type="email" name="email" required placeholder="user@example.com" className="input input-bordered input-md text-base" />
			</div>
			<div className="form-control">
				<label className="label"><span className="label-text text-base">Role</span></label>
				<select name="role" className="select select-bordered select-md text-base" defaultValue="user">
					<option value="user">User</option>
					<option value="admin">Admin</option>
				</select>
			</div>
			<div className="form-control justify-end">
				<button type="submit" disabled={pending} className="btn btn-error btn-md text-base">
					{pending ? 'Adding…' : 'Add user'}
				</button>
			</div>

			{error && (
				<div className="sm:col-span-2 alert alert-error text-base py-3">
					{error}
				</div>
			)}
			{success && (
				<div className="sm:col-span-2 alert alert-success text-base py-3">
					User added successfully.
				</div>
			)}
		</form>
	);
}
