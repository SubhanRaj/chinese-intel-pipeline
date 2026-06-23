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
	IconX,
	IconArticle,
	IconLanguage,
} from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
	const [dark, setDark] = useState(false);
	const [drawerArticle, setDrawerArticle] = useState<IntelArticle | null>(null);
	const [, startTransition] = useTransition();

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark);
	}, [dark]);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerArticle(null); };
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	const selected = briefings.find((b) => b.id === selectedId) ?? null;
	const selectedArticles = selected
		? articles.filter((a) => a.trackingDate === selected.trackingDate)
		: [];

	const hasArticles = selectedArticles.length > 0;
	const hasMarkdown = selected?.aiAnalysisMarkdown && selected.aiAnalysisMarkdown !== 'articles';

	// ── Sidebar ───────────────────────────────────────────────────────────────
	const sidebar = (
		<aside className="w-80 shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 print:hidden">
			<div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between">
				<div>
					<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-1">
						Intelligence Monitor
					</p>
					<h1 className="text-base font-semibold text-slate-900 dark:text-slate-100 leading-snug tracking-tight">
						Chinese Provincial Press
					</h1>
					<p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Daily briefings · CST</p>
				</div>
				<button
					onClick={() => setDark((d) => !d)}
					className="mt-1 p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					aria-label="Toggle colour mode"
				>
					{dark ? <IconSun size={18} /> : <IconMoon size={18} />}
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto py-2 px-2">
				{briefings.length === 0 ? (
					<p className="text-sm text-slate-500 text-center mt-8 px-4 leading-relaxed">
						No briefings on record yet.
					</p>
				) : (
					briefings.map((b) => {
						const isActive = selectedId === b.id;
						return (
							<button
								key={b.id}
								onClick={() => { setSelectedId(b.id); setDrawerArticle(null); }}
								className={[
									'w-full text-left rounded-lg px-4 py-3 mb-1 flex items-center gap-3 transition-all duration-100',
									isActive
										? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
										: 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200',
								].join(' ')}
							>
								<IconCalendar size={16} className="shrink-0 text-slate-400 dark:text-slate-500" />
								<span className="flex-1 text-sm font-mono font-medium tracking-wide">
									{b.trackingDate}
								</span>
								{isActive && <IconChevronRight size={14} className="text-red-600 dark:text-red-500 shrink-0" />}
							</button>
						);
					})
				)}
			</nav>

			<div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800">
				<p className="text-xs text-slate-500 dark:text-slate-500">
					{briefings.length} briefing{briefings.length !== 1 ? 's' : ''} on record
				</p>
			</div>
		</aside>
	);

	// ── Empty state ───────────────────────────────────────────────────────────
	if (briefings.length === 0) {
		return (
			<div className="flex h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
				{sidebar}
				<main className="flex-1 flex items-center justify-center">
					<div className="text-center max-w-sm px-6">
						<div className="flex justify-center mb-6">
							<IconNews size={56} className="text-slate-300 dark:text-slate-700" />
						</div>
						<h2 className="text-xl font-semibold text-slate-700 dark:text-slate-200 mb-2">
							No intelligence briefings yet.
						</h2>
						<p className="text-sm text-slate-500 leading-relaxed">
							The first automated run will execute at{' '}
							<span className="text-slate-700 dark:text-slate-300 font-mono">09:30 CST</span>.
						</p>
						<div className="mt-6 inline-flex items-center gap-2 text-sm text-slate-500 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-2">
							<span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
							<IconClock size={14} />
							cron <span className="font-mono ml-1">30 1 * * *</span>
						</div>
					</div>
				</main>
			</div>
		);
	}

	// ── Main layout ───────────────────────────────────────────────────────────
	return (
		<div className="flex h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
			{sidebar}

			<main className="flex-1 overflow-y-auto print:overflow-visible print:h-auto">
				{selected === null ? (
					<div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
						<IconNews size={48} className="text-slate-300 dark:text-slate-700" />
						<p className="text-base text-slate-500">Select a briefing date from the sidebar.</p>
					</div>
				) : (
					<div className="max-w-3xl mx-auto px-10 py-10">

						{/* Header */}
						<header className="mb-8 pb-6 border-b border-slate-200 dark:border-slate-800">
							<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-2">
								Intelligence Briefing
							</p>
							<h2 className="font-serif text-5xl text-slate-900 dark:text-slate-100 tracking-tight">
								{selected.trackingDate}
							</h2>
							<div className="flex items-center justify-between mt-4 flex-wrap gap-3">
								<p className="text-sm text-slate-500 dark:text-slate-400">
									Chinese Provincial Press Monitor · 7 Sources · CST Morning Edition
								</p>
								<Button
									variant="outline"
									size="sm"
									onClick={() => window.print()}
									className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 print:hidden"
								>
									<IconPrinter size={15} />
									Print Briefing
								</Button>
							</div>
						</header>

						{/* Content */}
						{hasArticles ? (
							<ArticleCardList
								articles={selectedArticles}
								onPreserve={(id, current) => startTransition(() => togglePreserve(id, current))}
								onDelete={(id) => startTransition(() => deleteArticle(id))}
								onReadFull={(article) => setDrawerArticle(article)}
							/>
						) : hasMarkdown ? (
							<div className="prose dark:prose-invert prose-slate max-w-none
								prose-headings:font-serif prose-headings:text-slate-900 dark:prose-headings:text-slate-100
								prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-p:leading-7
								prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-b prose-h2:border-slate-200 dark:prose-h2:border-slate-800 prose-h2:pb-2
								prose-h3:text-xs prose-h3:font-bold prose-h3:uppercase prose-h3:tracking-widest prose-h3:text-red-600 dark:prose-h3:text-red-500 prose-h3:mt-8 prose-h3:mb-3
								prose-li:text-slate-700 dark:prose-li:text-slate-300 prose-li:leading-7
								prose-hr:border-slate-200 dark:prose-hr:border-slate-800 prose-hr:my-8
							">
								<MarkdownRenderer content={selected.aiAnalysisMarkdown!} />
							</div>
						) : (
							<div className="text-sm text-slate-500 border border-slate-200 dark:border-slate-800 rounded-xl px-5 py-4 bg-white dark:bg-slate-900/40">
								Analysis pending — check back after the next scheduled run.
							</div>
						)}
					</div>
				)}
			</main>

			{/* Slide-in article drawer */}
			<ArticleDrawer article={drawerArticle} onClose={() => setDrawerArticle(null)} />
		</div>
	);
}

// ─── Article card list ────────────────────────────────────────────────────────

interface CardListProps {
	articles: IntelArticle[];
	onPreserve: (id: number, current: number) => void;
	onDelete: (id: number) => void;
	onReadFull: (article: IntelArticle) => void;
}

function ArticleCardList({ articles, onPreserve, onDelete, onReadFull }: CardListProps) {
	return (
		<div className="space-y-4">
			{articles.map((article) => (
				<ArticleCard
					key={article.id}
					article={article}
					onPreserve={onPreserve}
					onDelete={onDelete}
					onReadFull={onReadFull}
				/>
			))}
		</div>
	);
}

interface ArticleCardProps {
	article: IntelArticle;
	onPreserve: (id: number, current: number) => void;
	onDelete: (id: number) => void;
	onReadFull: (article: IntelArticle) => void;
}

function ArticleCard({ article, onPreserve, onDelete, onReadFull }: ArticleCardProps) {
	const isHigh = article.summary?.includes('[HIGH]');

	return (
		<Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm pb-0">
			<CardHeader className="pb-2">
				<div className="flex items-start justify-between gap-3">
					<CardTitle className="font-serif text-xl text-slate-900 dark:text-slate-100 leading-snug">
						{article.title ?? 'Untitled Article'}
					</CardTitle>
					{isHigh && (
						<Badge variant="destructive" className="shrink-0 text-xs px-2 py-0.5 mt-0.5">
							HIGH
						</Badge>
					)}
				</div>
			</CardHeader>

			<CardContent className="pt-0 pb-4 space-y-4">
				{/* AI summary */}
				{article.summary && (
					<p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed">
						{article.summary.replace(/\[HIGH\]/g, '').trim()}
					</p>
				)}

				{/* Action row */}
				<div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
					<div className="flex items-center gap-4">
						<button
							onClick={() => onReadFull(article)}
							className="inline-flex items-center gap-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors"
						>
							<IconArticle size={15} />
							Read Full Article
						</button>
						{article.url && (
							<a
								href={article.url}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors hover:underline underline-offset-2"
							>
								<IconExternalLink size={14} />
								Source
							</a>
						)}
					</div>

					<div className="flex items-center gap-1 print:hidden">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPreserve(article.id, article.isPreserved ?? 0)}
							className={[
								'h-8 px-3 text-sm gap-1.5',
								article.isPreserved
									? 'text-amber-600 dark:text-amber-400'
									: 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400',
							].join(' ')}
						>
							{article.isPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							{article.isPreserved ? 'Preserved' : 'Preserve'}
						</Button>

						<Button
							variant="ghost"
							size="sm"
							onClick={() => onDelete(article.id)}
							className="h-8 px-3 text-sm gap-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400"
						>
							<IconTrash size={15} />
							Delete
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Right slide-in drawer ────────────────────────────────────────────────────

interface DrawerProps {
	article: IntelArticle | null;
	onClose: () => void;
}

function ArticleDrawer({ article, onClose }: DrawerProps) {
	const [showChinese, setShowChinese] = useState(false);
	const open = article !== null;

	// Reset toggle when a different article opens
	useEffect(() => { setShowChinese(false); }, [article?.id]);

	return (
		<>
			{/* Backdrop */}
			<div
				onClick={onClose}
				className={[
					'fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity duration-300',
					open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
				].join(' ')}
			/>

			{/* Panel */}
			<div
				className={[
					'fixed top-0 right-0 z-50 h-full w-[48%] min-w-[440px] bg-white dark:bg-slate-900 shadow-2xl flex flex-col transition-transform duration-300 ease-in-out',
					open ? 'translate-x-0' : 'translate-x-full',
				].join(' ')}
			>
				{/* Drawer header */}
				<div className="flex items-center justify-between px-7 py-5 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<div>
						<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-0.5">
							Full Article
						</p>
						<p className="text-sm text-slate-500 dark:text-slate-400">
							English analysis + translation
						</p>
					</div>
					<div className="flex items-center gap-2">
						{/* Chinese source toggle */}
						{article?.fullText && (
							<button
								onClick={() => setShowChinese((v) => !v)}
								className={[
									'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors',
									showChinese
										? 'bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-400'
										: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 hover:text-slate-800 dark:hover:text-slate-200',
								].join(' ')}
							>
								<IconLanguage size={13} />
								{showChinese ? 'Show English' : '中文 Source'}
							</button>
						)}
						<button
							onClick={onClose}
							className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
							aria-label="Close"
						>
							<IconX size={18} />
						</button>
					</div>
				</div>

				{/* Drawer body */}
				<div className="flex-1 overflow-y-auto px-7 py-7 space-y-7">
					{article && (
						<>
							{/* Title + source link */}
							<div className="space-y-2">
								<h2 className="font-serif text-2xl text-slate-900 dark:text-slate-100 leading-snug">
									{article.title}
								</h2>
								{article.url && (
									<a
										href={article.url}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 break-all"
									>
										<IconExternalLink size={14} className="shrink-0" />
										{article.url}
									</a>
								)}
							</div>

							{showChinese ? (
								/* Chinese source text */
								<div>
									<p className="text-xs font-bold tracking-widest uppercase text-amber-600 dark:text-amber-500 mb-4">
										Source Text (Chinese)
									</p>
									<div className="rounded-xl bg-amber-50/60 dark:bg-slate-950 border border-amber-200 dark:border-amber-500/20 p-5">
										<pre className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap break-words font-mono">
											{article.fullText}
										</pre>
									</div>
								</div>
							) : (
								<>
									{/* AI summary */}
									<div>
										<p className="text-xs font-bold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-3">
											Geopolitical Summary
										</p>
										<p className="text-base text-slate-700 dark:text-slate-200 leading-relaxed">
											{article.summary?.replace(/\[HIGH\]/g, '').trim() ?? 'No summary available.'}
										</p>
									</div>

									{/* Full English translation */}
									{article.fullTextEn ? (
										<div>
											<p className="text-xs font-bold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-3">
												Full Article (English Translation)
											</p>
											<div className="prose prose-slate dark:prose-invert max-w-none
												prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-p:leading-7 prose-p:text-base">
												<p>{article.fullTextEn}</p>
											</div>
										</div>
									) : (
										<div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-5 py-4">
											<p className="text-sm text-slate-500 dark:text-slate-400">
												Full English translation not available for this article.
												Toggle to <strong>中文 Source</strong> to read the original.
											</p>
										</div>
									)}
								</>
							)}
						</>
					)}
				</div>
			</div>
		</>
	);
}
