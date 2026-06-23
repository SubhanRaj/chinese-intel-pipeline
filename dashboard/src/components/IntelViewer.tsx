'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import {
	IconSun,
	IconMoon,
	IconNews,
	IconCalendar,
	IconSourceCode,
	IconLanguage,
	IconClock,
	IconChevronRight,
	IconAlertCircle,
} from '@tabler/icons-react';
import type { IntelBriefing } from '@/db/schema';

const MarkdownRenderer = dynamic(() => import('./MarkdownRenderer'), { ssr: false });

interface Props {
	briefings: IntelBriefing[];
}

export default function IntelViewer({ briefings }: Props) {
	const [selectedId, setSelectedId] = useState<number | null>(
		briefings.length > 0 ? briefings[0].id : null,
	);
	const [showRaw, setShowRaw] = useState(false);
	const [dark, setDark] = useState(true);

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark);
	}, [dark]);

	const selected = briefings.find((b) => b.id === selectedId) ?? null;

	const sidebar = (
		<aside className="w-72 shrink-0 flex flex-col border-r border-slate-800 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 border-slate-200">
			{/* Header */}
			<div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between">
				<div>
					<p className="text-[10px] font-bold tracking-[0.18em] uppercase text-red-500 mb-0.5">
						Intelligence Monitor
					</p>
					<h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
						Chinese Provincial Press
					</h1>
					<p className="text-[11px] text-slate-400 mt-0.5">Daily briefings · CST</p>
				</div>
				<button
					onClick={() => setDark((d) => !d)}
					className="mt-0.5 p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
					aria-label="Toggle colour mode"
				>
					{dark ? <IconSun size={16} /> : <IconMoon size={16} />}
				</button>
			</div>

			{/* Date list */}
			<nav className="flex-1 overflow-y-auto py-2 px-2">
				{briefings.length === 0 ? (
					<p className="text-xs text-slate-400 text-center mt-8 px-4 leading-relaxed">
						No briefings on record yet.
					</p>
				) : (
					briefings.map((b) => {
						const isActive = selectedId === b.id;
						return (
							<button
								key={b.id}
								onClick={() => { setSelectedId(b.id); setShowRaw(false); }}
								className={[
									'w-full text-left rounded-lg px-3 py-2.5 mb-0.5 flex items-center gap-2.5 transition-all duration-100 group',
									isActive
										? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
										: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-200',
								].join(' ')}
							>
								<IconCalendar size={14} className="shrink-0 opacity-60" />
								<span className="flex-1 text-xs font-mono font-medium tracking-wide">
									{b.trackingDate}
								</span>
								{isActive && (
									<IconChevronRight size={12} className="text-red-500 shrink-0" />
								)}
							</button>
						);
					})
				)}
			</nav>

			{/* Footer */}
			<div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800">
				<p className="text-[10px] text-slate-400">
					{briefings.length} briefing{briefings.length !== 1 ? 's' : ''} on record
				</p>
			</div>
		</aside>
	);

	if (briefings.length === 0) {
		return (
			<div className="flex h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
				{sidebar}
				<main className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-950">
					<div className="text-center max-w-sm px-6">
						<div className="flex justify-center mb-5">
							<IconNews size={48} className="text-slate-300 dark:text-slate-700" />
						</div>
						<h2 className="text-base font-semibold text-slate-700 dark:text-slate-200 mb-2">
							No intelligence briefings available yet.
						</h2>
						<p className="text-sm text-slate-500 leading-relaxed">
							The first automated run will execute at{' '}
							<span className="text-slate-700 dark:text-slate-300 font-mono">06:00 CST</span>.
						</p>
						<div className="mt-6 inline-flex items-center gap-2 text-[11px] text-slate-400 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2">
							<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
							<IconClock size={12} />
							cron <span className="font-mono ml-1">0 22 * * *</span>
						</div>
					</div>
				</main>
			</div>
		);
	}

	return (
		<div className="flex h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
			{sidebar}

			{/* ── Main content panel ────────────────────────────────────── */}
			<main className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950">
				{selected === null ? (
					<div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
						<IconNews size={40} className="text-slate-300 dark:text-slate-700" />
						<p className="text-sm">Select a briefing date from the sidebar.</p>
					</div>
				) : (
					<div className="max-w-3xl mx-auto px-10 py-10">

						{/* Briefing header */}
						<header className="mb-8 pb-6 border-b border-slate-200 dark:border-slate-800">
							<p className="text-[10px] font-bold tracking-[0.18em] uppercase text-red-500 mb-2">
								Intelligence Briefing
							</p>
							<h2 className="text-3xl font-bold text-slate-900 dark:text-slate-100 tracking-tight font-mono">
								{selected.trackingDate}
							</h2>
							<div className="flex items-center justify-between mt-3">
								<p className="text-xs text-slate-400">
									Chinese Provincial Press Monitor · 7 Sources · CST Morning Edition
								</p>
								{selected.rawScrapedText && (
									<button
										onClick={() => setShowRaw((v) => !v)}
										className={[
											'flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors',
											showRaw
												? 'bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-400'
												: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200',
										].join(' ')}
									>
										{showRaw ? (
											<><IconLanguage size={13} /> Show English</>
										) : (
											<><IconSourceCode size={13} /> View Source 中文</>
										)}
									</button>
								)}
							</div>
						</header>

						{/* Content body */}
						{showRaw ? (
							<div className="rounded-xl border border-amber-200 dark:border-amber-500/20 bg-amber-50/50 dark:bg-slate-900/60 p-6">
								<p className="text-[10px] font-bold tracking-[0.18em] uppercase text-amber-600 dark:text-amber-500 mb-4">
									Raw Scraped Chinese Text
								</p>
								<pre className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap break-words font-mono">
									{selected.rawScrapedText}
								</pre>
							</div>
						) : selected.aiAnalysisMarkdown ? (
							<div className="
								prose dark:prose-invert prose-slate max-w-none
								prose-p:text-slate-600 dark:prose-p:text-slate-300 prose-p:leading-7
								prose-headings:text-slate-900 dark:prose-headings:text-slate-100 prose-headings:font-semibold prose-headings:tracking-tight
								prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-b prose-h2:border-slate-200 dark:prose-h2:border-slate-800 prose-h2:pb-2
								prose-h3:text-xs prose-h3:font-bold prose-h3:uppercase prose-h3:tracking-widest prose-h3:text-red-500 prose-h3:mt-8 prose-h3:mb-3
								prose-ul:space-y-2 prose-li:text-slate-600 dark:prose-li:text-slate-300 prose-li:leading-7
								prose-strong:text-slate-900 dark:prose-strong:text-slate-100 prose-strong:font-semibold
								prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
								prose-hr:border-slate-200 dark:prose-hr:border-slate-800 prose-hr:my-8
								prose-code:text-amber-700 dark:prose-code:text-amber-300 prose-code:bg-amber-50 dark:prose-code:bg-slate-900 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono
								prose-blockquote:border-l-red-500 prose-blockquote:text-slate-500 dark:prose-blockquote:text-slate-400 prose-blockquote:bg-slate-100 dark:prose-blockquote:bg-slate-900/50 prose-blockquote:py-1
							">
								<MarkdownRenderer content={selected.aiAnalysisMarkdown!} />
							</div>
						) : (
							<div className="flex items-center gap-3 text-slate-500 text-sm border border-slate-200 dark:border-slate-800 rounded-xl px-5 py-4 bg-white dark:bg-slate-900/40">
								<IconAlertCircle size={18} className="text-slate-400 shrink-0" />
								Analysis pending — check back after the next scheduled run.
							</div>
						)}
					</div>
				)}
			</main>
		</div>
	);
}
