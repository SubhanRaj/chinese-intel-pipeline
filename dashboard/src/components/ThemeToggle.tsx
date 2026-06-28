'use client';

import { useState, useEffect } from 'react';
import { IconSun, IconMoon, IconDeviceLaptop } from '@tabler/icons-react';

type Theme = 'system' | 'dark' | 'light';

export default function ThemeToggle({ className }: { className?: string }) {
	const [theme, setTheme] = useState<Theme>('system');
	const [hydrated, setHydrated] = useState(false);

	useEffect(() => {
		const saved = localStorage.getItem('intel-theme');
		if (saved === 'dark') setTheme('dark');
		else if (saved === 'light') setTheme('light');
		else setTheme('system');
		setHydrated(true);
	}, []);

	useEffect(() => {
		if (!hydrated) return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const apply = () => {
			const isDark = theme === 'dark' || (theme === 'system' && mq.matches);
			document.documentElement.classList.toggle('dark', isDark);
		};
		apply();
		if (theme === 'system') localStorage.removeItem('intel-theme');
		else localStorage.setItem('intel-theme', theme);
		if (theme === 'system') {
			mq.addEventListener('change', apply);
			return () => mq.removeEventListener('change', apply);
		}
	}, [theme, hydrated]);

	const cycle = () => setTheme(t => t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system');

	return (
		<button
			onClick={cycle}
			className={className ?? 'p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors'}
			aria-label={theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark mode' : 'Light mode'}
			title={theme === 'system' ? 'System theme (click for dark)' : theme === 'dark' ? 'Dark mode (click for light)' : 'Light mode (click for system)'}
		>
			{theme === 'dark' ? <IconSun size={18} /> : theme === 'light' ? <IconMoon size={18} /> : <IconDeviceLaptop size={18} />}
		</button>
	);
}
