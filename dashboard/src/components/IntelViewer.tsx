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
	IconLock,
	IconMenu2,
	IconSearch,
	IconArchive,
	IconLayoutGrid,
	IconCheck,
	IconMinus,
} from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { togglePreserve, deleteArticle, unpreserveAndDelete } from '@/app/actions';
import { safeUrl } from '@/lib/utils';
import type { IntelBriefing, IntelArticle, TempArticle } from '@/db/schema';

const MarkdownRenderer = dynamic(() => import('./MarkdownRenderer'), { ssr: false });

// ── Category colours ──────────────────────────────────────────────────────────

const CATEGORY_STYLES: Record<string, string> = {
	'Political':      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
	'Military':       'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
	'Economic':       'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
	'Technology':     'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
	'Social':         'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
	'Foreign Affairs':'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

function categoryStyle(cat: string | null | undefined): string {
	return cat ? (CATEGORY_STYLES[cat] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400') : '';
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
	briefings: IntelBriefing[];
	articles: IntelArticle[];
	feed: TempArticle[];
}

type View = 'briefing' | 'preserved' | 'feed';

export default function IntelViewer({ briefings, articles, feed }: Props) {
	const [selectedId, setSelectedId] = useState<number | null>(
		briefings.length > 0 ? briefings[0].id : null,
	);
	const [dark, setDark] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [drawerArticle, setDrawerArticle] = useState<IntelArticle | null>(null);
	const [view, setView] = useState<View>('briefing');
	const [searchQuery, setSearchQuery] = useState('');
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
	const preservedArticles = articles.filter((a) => a.isPreserved);

	const hasArticles = selectedArticles.length > 0;
	const hasMarkdown = selected?.aiAnalysisMarkdown && selected.aiAnalysisMarkdown !== 'articles';

	// Feed: most recent tracking_date in temp_articles
	const feedDate = feed.length > 0 ? feed[0].trackingDate : null;
	const todayFeed = feedDate ? feed.filter(a => a.trackingDate === feedDate) : [];
	// Group by source, preserving insertion order of first occurrence
	const feedBySource = todayFeed.reduce<Record<string, TempArticle[]>>((acc, a) => {
		if (!acc[a.source]) acc[a.source] = [];
		acc[a.source].push(a);
		return acc;
	}, {});

	// Search filtering
	function matchesSearch(a: IntelArticle) {
		if (!searchQuery) return true;
		const q = searchQuery.toLowerCase();
		return (
			(a.title?.toLowerCase().includes(q) ?? false) ||
			(a.summary?.toLowerCase().includes(q) ?? false) ||
			(a.source?.toLowerCase().includes(q) ?? false)
		);
	}

	const visibleBriefingArticles = selectedArticles.filter(matchesSearch);
	const visiblePreservedArticles = preservedArticles.filter(matchesSearch);

	// ── Sidebar ───────────────────────────────────────────────────────────────
	const sidebar = (
		<>
			{/* Mobile backdrop */}
			<div
				onClick={() => setSidebarOpen(false)}
				className={[
					'fixed inset-0 z-20 bg-black/40 md:hidden transition-opacity duration-300',
					sidebarOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
				].join(' ')}
			/>

			<aside className={[
				'fixed md:relative inset-y-0 left-0 z-30 w-80 shrink-0 flex flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 print:hidden transition-transform duration-300 ease-in-out md:translate-x-0',
				sidebarOpen ? 'translate-x-0' : '-translate-x-full',
			].join(' ')}>
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
					<div className="flex items-center gap-1">
						<button
							onClick={() => setDark((d) => !d)}
							className="mt-1 p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
							aria-label="Toggle colour mode"
						>
							{dark ? <IconSun size={18} /> : <IconMoon size={18} />}
						</button>
						<button
							onClick={() => setSidebarOpen(false)}
							className="mt-1 p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors md:hidden"
							aria-label="Close sidebar"
						>
							<IconX size={18} />
						</button>
					</div>
				</div>

				<nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
					{/* ── Preserved section ────────────────────────────────── */}
					{preservedArticles.length > 0 && (
						<div>
							<button
								onClick={() => { setView('preserved'); setSearchQuery(''); setSidebarOpen(false); }}
								className={[
									'w-full px-3 mb-1 flex items-center justify-between rounded-lg py-1.5 transition-colors',
									view === 'preserved'
										? 'bg-amber-50 dark:bg-amber-500/10'
										: 'hover:bg-slate-100 dark:hover:bg-slate-800/60',
								].join(' ')}
							>
								<span className="text-[10px] font-bold tracking-widest uppercase text-amber-600 dark:text-amber-500 flex items-center gap-1.5">
									<IconBookmarkFilled size={11} />
									Preserved ({preservedArticles.length})
								</span>
								<IconChevronRight size={11} className="text-amber-500" />
							</button>
							{preservedArticles.map((a) => (
								<button
									key={a.id}
									onClick={() => { setDrawerArticle(a); setSidebarOpen(false); }}
									className="w-full text-left rounded-lg px-3 py-2 mb-0.5 flex items-start gap-2.5 transition-all duration-100 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200 group"
								>
									<IconBookmark size={13} className="shrink-0 mt-0.5 text-amber-500" />
									<div className="flex-1 min-w-0">
										<p className="text-xs font-medium leading-snug truncate">
											{a.title ?? 'Untitled'}
										</p>
										<p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono mt-0.5">
											{a.trackingDate}
										</p>
									</div>
									<IconChevronRight size={11} className="shrink-0 mt-1 opacity-0 group-hover:opacity-100 text-slate-400 transition-opacity" />
								</button>
							))}
							<div className="mt-3 border-t border-slate-200 dark:border-slate-800" />
						</div>
					)}

					{/* ── Today's Feed ─────────────────────────────────── */}
					{todayFeed.length > 0 && (
						<div>
							<button
								onClick={() => { setView('feed'); setSearchQuery(''); setSidebarOpen(false); }}
								className={[
									'w-full px-3 mb-1 flex items-center justify-between rounded-lg py-1.5 transition-colors',
									view === 'feed'
										? 'bg-emerald-50 dark:bg-emerald-500/10'
										: 'hover:bg-slate-100 dark:hover:bg-slate-800/60',
								].join(' ')}
							>
								<span className="text-[10px] font-bold tracking-widest uppercase text-emerald-600 dark:text-emerald-500 flex items-center gap-1.5">
									<IconLayoutGrid size={11} />
									Today's Feed ({todayFeed.length})
								</span>
								<IconChevronRight size={11} className="text-emerald-500" />
							</button>
							<div className="mt-2 border-t border-slate-200 dark:border-slate-800" />
						</div>
					)}

					{/* ── Date list ────────────────────────────────────────── */}
					<div>
						{briefings.length > 0 && (
							<p className="px-3 mb-1 text-[10px] font-bold tracking-widest uppercase text-slate-400 dark:text-slate-500">
								Briefings
							</p>
						)}
						{briefings.length === 0 ? (
							<p className="text-sm text-slate-500 text-center mt-8 px-4 leading-relaxed">
								No briefings on record yet.
							</p>
						) : (
							briefings.map((b) => {
								const isActive = selectedId === b.id && view === 'briefing';
								return (
									<button
										key={b.id}
										onClick={() => { setSelectedId(b.id); setView('briefing'); setDrawerArticle(null); setSearchQuery(''); setSidebarOpen(false); }}
										className={[
											'w-full text-left rounded-lg px-3 py-2.5 mb-0.5 flex items-center gap-3 transition-all duration-100',
											isActive
												? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
												: 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200',
										].join(' ')}
									>
										<IconCalendar size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
										<span className="flex-1 text-sm font-mono font-medium tracking-wide">
											{b.trackingDate}
										</span>
										{isActive && <IconChevronRight size={13} className="text-red-600 dark:text-red-500 shrink-0" />}
									</button>
								);
							})
						)}
					</div>
				</nav>

				<div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800">
					<p className="text-xs text-slate-500 dark:text-slate-500">
						{briefings.length} briefing{briefings.length !== 1 ? 's' : ''} on record
					</p>
				</div>
			</aside>
		</>
	);

	// ── Mobile top bar ────────────────────────────────────────────────────────
	const mobileTopBar = (
		<div className="md:hidden flex items-center gap-3 px-4 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
			<button
				onClick={() => setSidebarOpen(true)}
				className="p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				aria-label="Open sidebar"
			>
				<IconMenu2 size={20} />
			</button>
			<div className="flex-1 min-w-0">
				<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 leading-none mb-0.5">
					Intelligence Monitor
				</p>
				<p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
					Chinese Provincial Press
				</p>
			</div>
		</div>
	);

	// ── Empty state ───────────────────────────────────────────────────────────
	if (briefings.length === 0) {
		return (
			<div className="flex h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
				{sidebar}
				<main className="flex-1 flex flex-col">
					{mobileTopBar}
					<div className="flex-1 flex items-center justify-center">
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
					</div>
				</main>
			</div>
		);
	}

	// ── Search bar ────────────────────────────────────────────────────────────
	const searchBar = (
		<div className="relative">
			<IconSearch size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
			<input
				type="text"
				value={searchQuery}
				onChange={(e) => setSearchQuery(e.target.value)}
				placeholder="Search articles…"
				className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400 transition-colors"
			/>
			{searchQuery && (
				<button
					onClick={() => setSearchQuery('')}
					className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
				>
					<IconX size={14} />
				</button>
			)}
		</div>
	);

	// ── Main layout ───────────────────────────────────────────────────────────
	return (
		<div className="flex h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
			{sidebar}

			<main className="flex-1 flex flex-col overflow-hidden md:overflow-y-auto print:overflow-visible print:h-auto">
				{mobileTopBar}
				<div className="flex-1 overflow-y-auto">

					{/* ── Preserved articles view ────────────────────────── */}
					{view === 'preserved' && (
						<div className="max-w-3xl mx-auto px-4 sm:px-10 py-10">
							<header className="mb-8 pb-6 border-b border-slate-200 dark:border-slate-800">
								<p className="text-xs font-bold tracking-widest uppercase text-amber-600 dark:text-amber-500 mb-2 flex items-center gap-1.5">
									<IconArchive size={13} />
									Preserved Articles
								</p>
								<h2 className="font-serif text-4xl text-slate-900 dark:text-slate-100 tracking-tight">
									Archive
								</h2>
								<p className="text-sm text-slate-500 dark:text-slate-400 mt-3">
									{preservedArticles.length} article{preservedArticles.length !== 1 ? 's' : ''} preserved · exempt from 30-day cleanup
								</p>
								<div className="mt-4">{searchBar}</div>
							</header>

							{visiblePreservedArticles.length === 0 ? (
								<div className="text-center py-16">
									<IconBookmarkFilled size={40} className="mx-auto text-slate-200 dark:text-slate-700 mb-4" />
									<p className="text-slate-500">
										{searchQuery ? 'No preserved articles match your search.' : 'No preserved articles yet.'}
									</p>
								</div>
							) : (
								<div className="space-y-4">
									{visiblePreservedArticles.map((a) => (
										<ArticleCard
											key={a.id}
											article={a}
											showDate
											onPreserve={(id, current) => startTransition(() => togglePreserve(id, current))}
											onDelete={(id) => startTransition(() => deleteArticle(id))}
											onReadFull={(article) => setDrawerArticle(article)}
										/>
									))}
								</div>
							)}
						</div>
					)}

					{/* ── Today's Feed view ──────────────────────────────── */}
					{view === 'feed' && (
						<div className="max-w-3xl mx-auto px-4 sm:px-10 py-10">
							<header className="mb-8 pb-6 border-b border-slate-200 dark:border-slate-800">
								<p className="text-xs font-bold tracking-widest uppercase text-emerald-600 dark:text-emerald-500 mb-2 flex items-center gap-1.5">
									<IconLayoutGrid size={13} />
									Today's Feed
								</p>
								<h2 className="font-serif text-4xl text-slate-900 dark:text-slate-100 tracking-tight">
									{feedDate ?? '—'}
								</h2>
								<p className="text-sm text-slate-500 dark:text-slate-400 mt-3">
									All {todayFeed.length} scraped articles · titles AI-translated ·{' '}
									<span className="text-emerald-600 dark:text-emerald-400 font-medium">
										{todayFeed.filter(a => a.isImportant).length} flagged for full analysis
									</span>
									{' '}· deleted at next morning run
								</p>
								<p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
									Click any source link to read the original. AI reasoning shown below each title.
								</p>
							</header>

							{Object.entries(feedBySource).map(([source, arts]) => (
								<div key={source} className="mb-8">
									<div className="flex items-center gap-3 mb-3">
										<h3 className="text-xs font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400">
											{source}
										</h3>
										<div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
										<span className="text-[10px] font-mono text-slate-400">{arts.length} articles</span>
									</div>

									<div className="space-y-2">
										{arts.map(a => (
											<div
												key={a.id}
												className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-3 flex items-start gap-3"
											>
												<div className="mt-0.5 shrink-0">
													{a.isImportant ? (
														<span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
															<IconCheck size={11} strokeWidth={2.5} />
														</span>
													) : (
														<span className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600">
															<IconMinus size={11} strokeWidth={2.5} />
														</span>
													)}
												</div>

												<div className="flex-1 min-w-0">
													<p className={[
														'text-sm font-medium leading-snug',
														a.isImportant
															? 'text-slate-900 dark:text-slate-100'
															: 'text-slate-500 dark:text-slate-500',
													].join(' ')}>
														{a.titleEn ?? a.title}
													</p>
													{a.importanceReason && (
														<p className={[
															'text-[11px] mt-1 leading-relaxed',
															a.isImportant
																? 'text-emerald-600 dark:text-emerald-500'
																: 'text-slate-400 dark:text-slate-600',
														].join(' ')}>
															{a.isImportant ? '✓ ' : '— '}{a.importanceReason}
														</p>
													)}
												</div>

												{safeUrl(a.url) && (
													<a
														href={safeUrl(a.url)!}
														target="_blank"
														rel="noopener noreferrer"
														className="shrink-0 mt-0.5 text-slate-300 dark:text-slate-700 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
														title="Open original article"
													>
														<IconExternalLink size={14} />
													</a>
												)}
											</div>
										))}
									</div>
								</div>
							))}
						</div>
					)}

					{/* ── Daily briefing view ────────────────────────────── */}
					{view === 'briefing' && (
						selected === null ? (
							<div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
								<IconNews size={48} className="text-slate-300 dark:text-slate-700" />
								<p className="text-base text-slate-500">Select a briefing date from the sidebar.</p>
							</div>
						) : (
							<div className="max-w-3xl mx-auto px-4 sm:px-10 py-10">
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
									{hasArticles && <div className="mt-4">{searchBar}</div>}
								</header>

								{hasArticles ? (
									visibleBriefingArticles.length === 0 ? (
										<p className="text-sm text-slate-500 text-center py-12">No articles match your search.</p>
									) : (
										<div className="space-y-4">
											{visibleBriefingArticles.map((article) => (
												<ArticleCard
													key={article.id}
													article={article}
													onPreserve={(id, current) => startTransition(() => togglePreserve(id, current))}
													onDelete={(id) => startTransition(() => deleteArticle(id))}
													onReadFull={(article) => setDrawerArticle(article)}
												/>
											))}
										</div>
									)
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
						)
					)}
				</div>
			</main>

			{/* Slide-in article drawer */}
			<ArticleDrawer
				article={drawerArticle}
				onClose={() => setDrawerArticle(null)}
				onPreserve={(id, current) => {
					startTransition(() => togglePreserve(id, current));
					setDrawerArticle((prev) => prev ? { ...prev, isPreserved: current ? 0 : 1 } : null);
				}}
				onDelete={(id) => {
					startTransition(() => deleteArticle(id));
					setDrawerArticle(null);
				}}
				onUnpreserveAndDelete={(id) => {
					startTransition(() => unpreserveAndDelete(id));
					setDrawerArticle(null);
				}}
			/>
		</div>
	);
}

// ─── Article card ─────────────────────────────────────────────────────────────

interface ArticleCardProps {
	article: IntelArticle;
	showDate?: boolean;
	onPreserve: (id: number, current: number) => void;
	onDelete: (id: number) => void;
	onReadFull: (article: IntelArticle) => void;
}

function ArticleCard({ article, showDate, onPreserve, onDelete, onReadFull }: ArticleCardProps) {
	const isHigh = article.summary?.includes('[HIGH]');

	return (
		<Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm py-0">
			<CardHeader className="pt-5 pb-2">
				<div className="flex items-start justify-between gap-3">
					<div className="flex-1 min-w-0">
						{/* Category + source meta row */}
						{(article.category || article.source || showDate) && (
							<div className="flex flex-wrap items-center gap-1.5 mb-2">
								{article.category && (
									<span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle(article.category)}`}>
										{article.category}
									</span>
								)}
								{article.source && (
									<span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
										{article.source}
									</span>
								)}
								{showDate && (
									<span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
										· {article.trackingDate}
									</span>
								)}
							</div>
						)}
						<CardTitle className="font-serif text-xl text-slate-900 dark:text-slate-100 leading-snug">
							{article.title ?? 'Untitled Article'}
						</CardTitle>
					</div>
					{isHigh && (
						<Badge variant="destructive" className="shrink-0 text-xs px-2 py-0.5 mt-0.5">
							HIGH
						</Badge>
					)}
				</div>
			</CardHeader>

			<CardContent className="pt-0 pb-4 space-y-3">
				{/* AI summary — clamped to 2 lines on mobile, full on sm+ */}
				{article.summary && (
					<p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-2 sm:line-clamp-none">
						{article.summary.replace(/\[HIGH\]/g, '').trim()}
					</p>
				)}

				{/* Action row — always single horizontal row */}
				<div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
					<div className="flex items-center gap-3">
						<button
							onClick={() => onReadFull(article)}
							className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors py-1"
						>
							<IconArticle size={16} />
							<span>Read Full Article</span>
						</button>
						{safeUrl(article.url) && (
							<a
								href={safeUrl(article.url)!}
								target="_blank"
								rel="noopener noreferrer"
								className="hidden sm:inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors hover:underline underline-offset-2"
							>
								<IconExternalLink size={14} />
								Source
							</a>
						)}
					</div>

					<div className="flex items-center gap-0.5 print:hidden">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPreserve(article.id, article.isPreserved ?? 0)}
							className={[
								'h-8 px-2 sm:px-3 text-sm gap-1.5',
								article.isPreserved
									? 'text-amber-600 dark:text-amber-400'
									: 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400',
							].join(' ')}
							title={article.isPreserved ? 'Unpreserve' : 'Preserve'}
						>
							{article.isPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							<span className="hidden sm:inline">{article.isPreserved ? 'Preserved' : 'Preserve'}</span>
						</Button>

						<Button
							variant="ghost"
							size="sm"
							onClick={() => !article.isPreserved && onDelete(article.id)}
							disabled={!!article.isPreserved}
							className={[
								'h-8 px-2 sm:px-3 text-sm gap-1.5',
								article.isPreserved
									? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
									: 'text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400',
							].join(' ')}
							title={article.isPreserved ? 'Unpreserve before deleting' : 'Delete'}
						>
							{article.isPreserved ? <IconLock size={15} /> : <IconTrash size={15} />}
							<span className="hidden sm:inline">{article.isPreserved ? 'Locked' : 'Delete'}</span>
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
	onPreserve: (id: number, current: number) => void;
	onDelete: (id: number) => void;
	onUnpreserveAndDelete: (id: number) => void;
}

function ArticleDrawer({ article, onClose, onPreserve, onDelete, onUnpreserveAndDelete }: DrawerProps) {
	const [showChinese, setShowChinese] = useState(false);
	const open = article !== null;

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
					'fixed top-0 right-0 z-50 h-full w-full sm:w-[48%] sm:min-w-[440px] bg-white dark:bg-slate-900 shadow-2xl flex flex-col transition-transform duration-300 ease-in-out',
					open ? 'translate-x-0' : 'translate-x-full',
				].join(' ')}
			>
				{/* Drawer header */}
				<div className="flex items-center justify-between px-5 sm:px-7 py-5 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<div>
						<div className="flex items-center gap-2 mb-0.5">
							<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500">
								Full Article
							</p>
							{article?.category && (
								<span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle(article.category)}`}>
									{article.category}
								</span>
							)}
						</div>
						<p className="text-sm text-slate-500 dark:text-slate-400">
							{article?.source ? `${article.source} · ` : ''}English analysis + translation
						</p>
					</div>
					<div className="flex items-center gap-2">
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
				<div className="flex-1 overflow-y-auto px-5 sm:px-7 py-7 space-y-7">
					{article && (
						<>
							<div className="space-y-2">
								<h2 className="font-serif text-2xl text-slate-900 dark:text-slate-100 leading-snug">
									{article.title}
								</h2>
								{safeUrl(article.url) && (
									<a
										href={safeUrl(article.url)!}
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
									<div>
										<p className="text-xs font-bold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-3">
											Geopolitical Summary
										</p>
										<p className="text-base text-slate-700 dark:text-slate-200 leading-relaxed">
											{article.summary?.replace(/\[HIGH\]/g, '').trim() ?? 'No summary available.'}
										</p>
									</div>

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
										<div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 px-5 py-4">
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

				{/* Drawer footer */}
				{article && (
					<div className="shrink-0 px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPreserve(article.id, article.isPreserved ?? 0)}
							className={[
								'gap-2 text-sm',
								article.isPreserved
									? 'text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300'
									: 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400',
							].join(' ')}
						>
							{article.isPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							{article.isPreserved ? 'Preserved — click to unpreserve' : 'Preserve'}
						</Button>

						<div className="flex items-center gap-2">
							{article.isPreserved ? (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onUnpreserveAndDelete(article.id)}
									className="gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400"
									title="Remove preservation and permanently delete"
								>
									<IconTrash size={15} />
									Unpreserve &amp; Delete
								</Button>
							) : (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onDelete(article.id)}
									className="gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400"
								>
									<IconTrash size={15} />
									Delete
								</Button>
							)}
						</div>
					</div>
				)}
			</div>
		</>
	);
}
