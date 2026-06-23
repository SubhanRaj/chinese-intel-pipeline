'use client';

import { useState, useEffect, useTransition } from 'react';
import dynamic from 'next/dynamic';
import {
	IconSun,
	IconMoon,
	IconNews,
	IconCalendar,
	IconChevronRight,
	IconClock,
	IconPrinter,
	IconExternalLink,
	IconBookmark,
	IconBookmarkFilled,
	IconTrash,
	IconSourceCode,
	IconLanguage,
} from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from '@/components/ui/accordion';
import { togglePreserve, deleteArticle } from '@/app/actions';
import type { IntelBriefing, IntelArticle } from '@/db/schema';

const MarkdownRenderer = dynamic(() => import('./MarkdownRenderer'), { ssr: false });

interface Props {
	briefings: IntelBriefing[];
	articles: IntelArticle[];
}

export default function IntelViewer({ briefings, articles }: Props) {
	const [selectedId, setSelectedId] = useState<number | null>(
		briefings.length > 0 ? briefings[0].id : null,
	);
	const [showRaw, setShowRaw] = useState(false);
	const [dark, setDark] = useState(true);
	const [, startTransition] = useTransition();

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark);
	}, [dark]);

	const selected = briefings.find((b) => b.id === selectedId) ?? null;
	const selectedArticles = selected
		? articles.filter((a) => a.trackingDate === selected.trackingDate)
		: [];

	// True when briefing has per-article data; fall back to markdown for legacy records
	const hasArticles = selectedArticles.length > 0;
	const hasMarkdown =
		selected?.aiAnalysisMarkdown && selected.aiAnalysisMarkdown !== 'articles';

	const sidebar = (
		<aside className="w-72 shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 print:hidden">
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
									'w-full text-left rounded-lg px-3 py-2.5 mb-0.5 flex items-center gap-2.5 transition-all duration-100',
									isActive
										? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
										: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-800 dark:hover:text-slate-200',
								].join(' ')}
							>
								<IconCalendar size={14} className="shrink-0 opacity-60" />
								<span className="flex-1 text-xs font-mono font-medium tracking-wide">
									{b.trackingDate}
								</span>
								{isActive && <IconChevronRight size={12} className="text-red-500 shrink-0" />}
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
							<span className="text-slate-700 dark:text-slate-300 font-mono">09:30 CST</span>.
						</p>
						<div className="mt-6 inline-flex items-center gap-2 text-[11px] text-slate-400 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2">
							<span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
							<IconClock size={12} />
							cron <span className="font-mono ml-1">30 1 * * *</span>
						</div>
					</div>
				</main>
			</div>
		);
	}

	return (
		<div className="flex h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
			{sidebar}

			<main className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 print:overflow-visible print:h-auto">
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
							<div className="flex items-center justify-between mt-3 flex-wrap gap-2">
								<p className="text-xs text-slate-400">
									Chinese Provincial Press Monitor · 7 Sources · CST Morning Edition
								</p>

								<div className="flex items-center gap-2 print:hidden">
									{/* Raw toggle — only for legacy markdown records */}
									{hasMarkdown && (
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

									<Button
										variant="outline"
										size="sm"
										onClick={() => window.print()}
										className="flex items-center gap-1.5 text-[11px]"
									>
										<IconPrinter size={13} />
										Print Briefing
									</Button>
								</div>
							</div>
						</header>

						{/* Content body */}
						{showRaw && hasMarkdown ? (
							<div className="rounded-xl border border-amber-200 dark:border-amber-500/20 bg-amber-50/50 dark:bg-slate-900/60 p-6">
								<p className="text-[10px] font-bold tracking-[0.18em] uppercase text-amber-600 dark:text-amber-500 mb-4">
									Raw Scraped Chinese Text
								</p>
								<pre className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap break-words font-mono">
									{selected.rawScrapedText}
								</pre>
							</div>
						) : hasArticles ? (
							<ArticleCardList
								articles={selectedArticles}
								onPreserve={(id, current) =>
									startTransition(() => togglePreserve(id, current))
								}
								onDelete={(id) => startTransition(() => deleteArticle(id))}
							/>
						) : hasMarkdown ? (
							<div className="
								prose dark:prose-invert prose-slate max-w-none
								prose-p:text-slate-600 dark:prose-p:text-slate-300 prose-p:leading-7
								prose-headings:text-slate-900 dark:prose-headings:text-slate-100 prose-headings:font-semibold prose-headings:tracking-tight
								prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-b prose-h2:border-slate-200 dark:prose-h2:border-slate-800 prose-h2:pb-2
								prose-h3:text-xs prose-h3:font-bold prose-h3:uppercase prose-h3:tracking-widest prose-h3:text-red-500 prose-h3:mt-8 prose-h3:mb-3
								prose-ul:space-y-2 prose-li:text-slate-600 dark:prose-li:text-slate-300 prose-li:leading-7
								prose-strong:text-slate-900 dark:prose-strong:text-slate-100 prose-strong:font-semibold
								prose-hr:border-slate-200 dark:prose-hr:border-slate-800 prose-hr:my-8
								prose-code:text-amber-700 dark:prose-code:text-amber-300 prose-code:bg-amber-50 dark:prose-code:bg-slate-900 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono
								prose-blockquote:border-l-red-500 prose-blockquote:text-slate-500 dark:prose-blockquote:text-slate-400
							">
								<MarkdownRenderer content={selected.aiAnalysisMarkdown!} />
							</div>
						) : (
							<div className="flex items-center gap-3 text-slate-500 text-sm border border-slate-200 dark:border-slate-800 rounded-xl px-5 py-4 bg-white dark:bg-slate-900/40">
								Analysis pending — check back after the next scheduled run.
							</div>
						)}
					</div>
				)}
			</main>
		</div>
	);
}

// ---------- Article card list ----------

interface CardListProps {
	articles: IntelArticle[];
	onPreserve: (id: number, current: number) => void;
	onDelete: (id: number) => void;
}

function ArticleCardList({ articles, onPreserve, onDelete }: CardListProps) {
	return (
		<div className="space-y-4">
			{articles.map((article) => (
				<ArticleCard
					key={article.id}
					article={article}
					onPreserve={onPreserve}
					onDelete={onDelete}
				/>
			))}
		</div>
	);
}

interface ArticleCardProps {
	article: IntelArticle;
	onPreserve: (id: number, current: number) => void;
	onDelete: (id: number) => void;
}

function ArticleCard({ article, onPreserve, onDelete }: ArticleCardProps) {
	const isHigh = article.summary?.includes('[HIGH]');

	return (
		<Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-none">
			<CardHeader className="pb-2">
				<div className="flex items-start justify-between gap-3">
					<CardTitle className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
						{article.title ?? 'Untitled Article'}
					</CardTitle>
					{isHigh && (
						<Badge variant="destructive" className="shrink-0 text-[10px] px-1.5 py-0">
							HIGH
						</Badge>
					)}
				</div>
			</CardHeader>

			<CardContent className="pt-0 pb-3">
				{article.summary && (
					<p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-3">
						{article.summary.replace('[HIGH] ', '').replace('[HIGH]', '')}
					</p>
				)}

				{article.fullText && (
					<Accordion>
						<AccordionItem value="full-text" className="border-slate-200 dark:border-slate-700">
							<AccordionTrigger className="text-[11px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 py-2">
								Full source text (Chinese)
							</AccordionTrigger>
							<AccordionContent>
								<pre className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed whitespace-pre-wrap break-words font-mono bg-slate-50 dark:bg-slate-950 rounded-lg p-3 mt-1">
									{article.fullText}
								</pre>
							</AccordionContent>
						</AccordionItem>
					</Accordion>
				)}
			</CardContent>

			<CardFooter className="pt-0 flex items-center justify-between gap-2 flex-wrap">
				<div className="flex items-center gap-2">
					{article.url && (
						<a
							href={article.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline underline-offset-2"
						>
							<IconExternalLink size={12} />
							Source
						</a>
					)}
				</div>

				<div className="flex items-center gap-1.5 print:hidden">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onPreserve(article.id, article.isPreserved ?? 0)}
						className={[
							'h-7 px-2 text-[11px] gap-1',
							article.isPreserved
								? 'text-amber-600 dark:text-amber-400'
								: 'text-slate-400 hover:text-amber-600 dark:hover:text-amber-400',
						].join(' ')}
						title={article.isPreserved ? 'Remove from preserved' : 'Preserve this article'}
					>
						{article.isPreserved ? (
							<IconBookmarkFilled size={13} />
						) : (
							<IconBookmark size={13} />
						)}
						{article.isPreserved ? 'Preserved' : 'Preserve'}
					</Button>

					<Button
						variant="ghost"
						size="sm"
						onClick={() => onDelete(article.id)}
						className="h-7 px-2 text-[11px] gap-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
						title="Delete this article"
					>
						<IconTrash size={13} />
						Delete
					</Button>
				</div>
			</CardFooter>
		</Card>
	);
}
