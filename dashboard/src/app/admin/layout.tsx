import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

export const metadata = {
	title: 'Admin Panel',
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
	const session = await getSession();
	if (!session || session.role !== 'admin') redirect('/');

	return (
		<>
			{/* DaisyUI from CDN — admin panel only, not bundled into the main app */}
			<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5/dist/full.min.css" />
			<div data-theme="corporate" className="min-h-screen">
				{children}
			</div>
		</>
	);
}
