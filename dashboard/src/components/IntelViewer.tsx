'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { IntelBriefing } from '@/db/schema';

interface Props {
	briefings: IntelBriefing[];
}

export default function IntelViewer({ briefings }: Props) {
	const [selectedId, setSelectedId] = useState<number | null>(
		briefings.length > 0 ? briefings[0].id : null,
	);

	const selected = briefings.find((b) => b.id === selectedId) ?? null;

	if (briefings.length === 0) {
		return (
			<div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden">
				{/* Sidebar — empty state */}
				<aside className="w-72 shrink-0 flex flex-col border-r border-slate-800 bg-slate-900">
					<div className="px-6 py-5 border-b border-slate-800">
						<p className="text-[10px] font-bold tracking-[0.2em] uppercase text-red-500 mb-1">
							Intelligence Monitor
						</p>
						<h1 className="text-sm font-semibold text-slate-100 leading-snug">
							Chinese Provincial Press
						</h1>
						<p className="text-[11px] text-slate-500 mt-0.5">Daily briefings · CST</p>
					</div>
					<div className="flex-1 flex items-center justify-center px-6">
						<p className="text-xs text-slate-600 text-center leading-relaxed">
							No briefings on record yet.
						</p>
					</div>
					<div className="px-6 py-4 border-t border-slate-800">
						<p className="text-[10px] text-slate-600">0 briefings on record</p>
					</div>
				</aside>

				{/* Main panel — empty state */}
				<main className="flex-1 flex items-center justify-center bg-slate-950">
					<div className="text-center max-w-sm px-6">
						<div className="text-5xl mb-5">📰</div>
						<h2 className="text-base font-semibold text-slate-200 mb-2">
							No intelligence briefings available yet.
						</h2>
						<p className="text-sm text-slate-500 leading-relaxed">
							The first automated run will execute at{' '}
							<span className="text-slate-300 font-mono">06:00 CST</span>.
						</p>
						<div className="mt-6 inline-flex items-center gap-2 text-[11px] text-slate-600 border border-slate-800 rounded-md px-3 py-2">
							<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
							Worker scheduled · cron <span className="font-mono ml-1">0 22 * * *</span>
						</div>
					</div>
				</main>
			</div>
		);
	}

	return (
		<div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden">

			{/* ── Sidebar ───────────────────────────────────────────────── */}
			<aside className="w-72 shrink-0 flex flex-col border-r border-slate-800 bg-slate-900">

				{/* Header */}
				<div className="px-6 py-5 border-b border-slate-800">
					<p className="text-[10px] font-bold tracking-[0.2em] uppercase text-red-500 mb-1">
						Intelligence Monitor
					</p>
					<h1 className="text-sm font-semibold text-slate-100 leading-snug">
						Chinese Provincial Press
					</h1>
					<p className="text-[11px] text-slate-500 mt-0.5">Daily briefings · CST</p>
				</div>

				{/* Date list */}
				<nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-3">
					{/* briefings.length is always > 0 here */}
					{briefings.map((b) => {
						const isActive = selectedId === b.id;
						return (
							<button
								key={b.id}
								onClick={() => setSelectedId(b.id)}
								className={[
									'w-full text-left rounded-md px-3 py-3 transition-all duration-100 group',
									isActive
										? 'bg-slate-800 border border-slate-700'
										: 'border border-transparent hover:bg-slate-800/50',
								].join(' ')}
							>
								<span
									className={[
										'block text-xs font-mono font-semibold tracking-wide',
										isActive ? 'text-slate-100' : 'text-slate-400 group-hover:text-slate-200',
									].join(' ')}
								>
									{b.trackingDate}
								</span>
								{isActive && (
									<span className="block text-[10px] text-red-400 mt-0.5 tracking-wide">
										▶ Viewing
									</span>
								)}
							</button>
						);
					})}
				</nav>

				{/* Footer */}
				<div className="px-6 py-4 border-t border-slate-800">
					<p className="text-[10px] text-slate-600 leading-relaxed">
						{briefings.length} briefing{briefings.length !== 1 ? 's' : ''} on record
					</p>
				</div>
			</aside>

			{/* ── Main content panel ────────────────────────────────────── */}
			<main className="flex-1 overflow-y-auto bg-slate-950">
				{selected === null ? (
					<div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
						<div className="text-4xl">📰</div>
						<p className="text-sm">Select a briefing date from the sidebar.</p>
					</div>
				) : (
					<div className="max-w-3xl mx-auto px-10 py-10">

						{/* Briefing header */}
						<header className="mb-8 pb-6 border-b border-slate-800">
							<p className="text-[10px] font-bold tracking-[0.2em] uppercase text-red-500 mb-2">
								Intelligence Briefing
							</p>
							<h2 className="text-3xl font-bold text-slate-100 tracking-tight font-mono">
								{selected.trackingDate}
							</h2>
							<p className="text-xs text-slate-500 mt-2">
								Chinese Provincial Press Monitor · 7 Sources · CST Morning Edition
							</p>
						</header>

						{/* Markdown body */}
						{selected.aiAnalysisMarkdown ? (
							<div
								className="
									prose prose-invert prose-slate max-w-none
									prose-p:text-slate-300 prose-p:leading-7
									prose-headings:text-slate-100 prose-headings:font-semibold prose-headings:tracking-tight
									prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-b prose-h2:border-slate-800 prose-h2:pb-2
									prose-h3:text-sm prose-h3:font-bold prose-h3:uppercase prose-h3:tracking-widest prose-h3:text-red-400 prose-h3:mt-8 prose-h3:mb-3
									prose-ul:space-y-2 prose-li:text-slate-300 prose-li:leading-7
									prose-strong:text-slate-100 prose-strong:font-semibold
									prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
									prose-hr:border-slate-800 prose-hr:my-8
									prose-code:text-amber-300 prose-code:bg-slate-900 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono
									prose-blockquote:border-l-red-600 prose-blockquote:text-slate-400 prose-blockquote:bg-slate-900/50 prose-blockquote:py-1
								"
							>
								<ReactMarkdown>{selected.aiAnalysisMarkdown}</ReactMarkdown>
							</div>
						) : (
							<div className="flex items-center gap-3 text-slate-500 text-sm border border-slate-800 rounded-lg px-5 py-4 bg-slate-900/40">
								<span className="text-xl">⏳</span>
								Analysis pending — check back after the next scheduled run.
							</div>
						)}
					</div>
				)}
			</main>
		</div>
	);
}
