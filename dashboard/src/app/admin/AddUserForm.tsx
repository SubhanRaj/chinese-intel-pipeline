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
		<form ref={formRef} onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
			<div className="form-control">
				<label className="label"><span className="label-text">Name</span></label>
				<input type="text" name="name" required placeholder="Full name" className="input input-bordered input-sm" />
			</div>
			<div className="form-control">
				<label className="label"><span className="label-text">Email</span></label>
				<input type="email" name="email" required placeholder="user@example.com" className="input input-bordered input-sm" />
			</div>
			<div className="form-control">
				<label className="label"><span className="label-text">Role</span></label>
				<select name="role" className="select select-bordered select-sm" defaultValue="user">
					<option value="user">User</option>
					<option value="admin">Admin</option>
				</select>
			</div>
			<div className="form-control justify-end">
				<button type="submit" disabled={pending} className="btn btn-error btn-sm">
					{pending ? 'Adding…' : 'Add user'}
				</button>
			</div>

			{error && (
				<div className="sm:col-span-2 alert alert-error alert-sm py-2 text-sm">
					{error}
				</div>
			)}
			{success && (
				<div className="sm:col-span-2 alert alert-success alert-sm py-2 text-sm">
					User added successfully.
				</div>
			)}
		</form>
	);
}
