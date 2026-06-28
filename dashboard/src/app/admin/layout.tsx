import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import './admin.css';

export const metadata = {
	title: 'Admin Panel',
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
	const session = await getSession();
	if (!session || session.role !== 'admin') redirect('/');

	return (
		<div data-theme="corporate" className="min-h-screen">
			{children}
		</div>
	);
}
