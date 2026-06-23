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

	return (
		<div className="flex h-screen bg-gray-950 text-gray-100 font-mono overflow-hidden">
			{/* Sidebar */}
			<aside className="w-56 shrink-0 border-r border-gray-800 flex flex-col">
				<div className="px-4 py-3 border-b border-gray-800">
					<h1 className="text-xs font-bold uppercase tracking-widest text-red-400">
						China Intel
					</h1>
					<p className="text-[10px] text-gray-500 mt-0.5">Provincial Press Monitor</p>
				</div>
				<nav className="flex-1 overflow-y-auto py-2">
					{briefings.length === 0 && (
						<p className="px-4 py-3 text-xs text-gray-600">No briefings yet.</p>
					)}
					{briefings.map((b) => (
						<button
							key={b.id}
							onClick={() => setSelectedId(b.id)}
							className={`w-full text-left px-4 py-2.5 text-xs transition-colors ${
								selectedId === b.id
									? 'bg-red-900/40 text-red-300 border-l-2 border-red-500'
									: 'text-gray-400 hover:bg-gray-800/60 border-l-2 border-transparent'
							}`}
						>
							<span className="block font-semibold">{b.trackingDate}</span>
							<span
								className={`block text-[10px] mt-0.5 ${
									b.emailStatus === 1 ? 'text-green-600' : 'text-gray-600'
								}`}
							>
								{b.emailStatus === 1 ? '✓ emailed' : '● pending'}
							</span>
						</button>
					))}
				</nav>
			</aside>

			{/* Main panel */}
			<main className="flex-1 overflow-y-auto">
				{selected === null ? (
					<div className="flex items-center justify-center h-full text-gray-600 text-sm">
						Select a date from the sidebar.
					</div>
				) : (
					<article className="max-w-4xl mx-auto px-8 py-8">
						<header className="mb-6 pb-4 border-b border-gray-800">
							<p className="text-[10px] uppercase tracking-widest text-red-400 mb-1">
								Intelligence Briefing
							</p>
							<h2 className="text-2xl font-bold text-gray-100">{selected.trackingDate}</h2>
						</header>

						{selected.aiAnalysisMarkdown ? (
							<div className="prose prose-invert prose-sm max-w-none
								prose-headings:text-gray-100 prose-headings:font-bold
								prose-h2:text-xl prose-h2:mt-8 prose-h2:mb-3
								prose-h3:text-base prose-h3:text-red-400 prose-h3:mt-6 prose-h3:mb-2
								prose-p:text-gray-300 prose-p:leading-relaxed
								prose-li:text-gray-300 prose-li:leading-relaxed
								prose-strong:text-gray-100
								prose-a:text-blue-400
								prose-hr:border-gray-800
								prose-code:text-amber-300 prose-code:bg-gray-900 prose-code:px-1 prose-code:rounded">
								<ReactMarkdown>{selected.aiAnalysisMarkdown}</ReactMarkdown>
							</div>
						) : (
							<p className="text-gray-600 text-sm">Analysis not yet available.</p>
						)}
					</article>
				)}
			</main>
		</div>
	);
}
