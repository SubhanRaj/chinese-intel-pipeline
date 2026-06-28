'use client';

import { useState, useEffect } from 'react';

export default function ThemeToggle() {
	const [theme, setTheme] = useState<'system' | 'dark' | 'light'>('system');

	useEffect(() => {
		const saved = localStorage.getItem('intel-theme');
		if (saved === 'dark') setTheme('dark');
		else if (saved === 'light') setTheme('light');
		else setTheme('system');
	}, []);

	useEffect(() => {
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const isDark = theme === 'dark' || (theme === 'system' && mq.matches);
		document.documentElement.classList.toggle('dark', isDark);
		if (theme === 'system') localStorage.removeItem('intel-theme');
		else localStorage.setItem('intel-theme', theme);
	}, [theme]);

	const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
	const label = theme === 'system' ? '☀︎/☾ System' : theme === 'dark' ? '☾ Dark' : '☀︎ Light';

	return (
		<button
			onClick={() => setTheme(next)}
			className="btn btn-ghost btn-sm font-normal"
			title={`Theme: ${theme} — click for ${next}`}
		>
			{label}
		</button>
	);
}
