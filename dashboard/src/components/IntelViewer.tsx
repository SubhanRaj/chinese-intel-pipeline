'use client';

import { useState, useEffect, useTransition } from 'react';
import dynamic from 'next/dynamic';
import {
	IconSun,
	IconMoon,
	IconNews,
	IconCalendar,
	IconChevronRight,
	IconChevronLeft,
	IconClock,
	IconPrinter,
	IconExternalLink,
	IconBookmark,
	IconBookmarkFilled,
	IconTrash,
	IconX,
	IconLanguage,
	IconLock,
	IconMenu2,
	IconSearch,
	IconArchive,
	IconLayoutGrid,
	IconCheck,
	IconMinus,
	IconArticle,
	IconBuildings,
} from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { togglePreserve, deleteArticle, unpreserveAndDelete, togglePreserveCluster, deleteCluster } from '@/app/actions';
import { safeUrl } from '@/lib/utils';
import type { IntelBriefing, IntelArticle, IntelCluster, TempArticle } from '@/db/schema';

const MarkdownRenderer = dynamic(() => import('./MarkdownRenderer'), { ssr: false });

// ── Category colours ──────────────────────────────────────────────────────────

const CATEGORY_STYLES: Record<string, string> = {
	'Political':       'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
	'Military':        'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
	'Economic':        'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
	'Technology':      'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
	'Social':          'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
	'Foreign Affairs': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

function categoryStyle(cat: string | null | undefined): string {
	return cat ? (CATEGORY_STYLES[cat] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400') : '';
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
	briefings: IntelBriefing[];
	articles: IntelArticle[];
	clusters: IntelCluster[];
	feed: TempArticle[];
}

type View = 'briefing' | 'preserved' | 'feed' | 'search';

// ── Drawer state ──────────────────────────────────────────────────────────────

interface DrawerState {
	cluster: IntelCluster;
	articles: IntelArticle[];
}

export default function IntelViewer({ briefings, articles, clusters, feed }: Props) {
	const defaultBriefingId = briefings.length > 0 ? briefings[0].id : null;

	const [selectedId, setSelectedId] = useState<number | null>(defaultBriefingId);
	const [dark, setDark] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [drawer, setDrawer] = useState<DrawerState | null>(null);
	const [preservedDrawer, setPreservedDrawer] = useState<IntelArticle | null>(null);
	const [view, setView] = useState<View>('briefing');
	const [preSearchView, setPreSearchView] = useState<View>('briefing');
	// searchInput = what the user is typing; searchQuery = committed on Enter/submit
	const [searchInput, setSearchInput] = useState('');
	const [searchQuery, setSearchQuery] = useState('');
	const [, startTransition] = useTransition();
	const [hydrated, setHydrated] = useState(false);

	// Restore persisted state once on mount (after hydration)
	useEffect(() => {
		try {
			const savedDark = localStorage.getItem('intel-dark');
			if (savedDark !== null) setDark(savedDark === '1');

			const savedView = sessionStorage.getItem('intel-view') as View | null;
			if (savedView && ['briefing', 'preserved', 'feed'].includes(savedView)) setView(savedView);

			const savedId = sessionStorage.getItem('intel-selected-id');
			if (savedId) {
				const id = Number(savedId);
				if (briefings.some(b => b.id === id)) setSelectedId(id);
			}

			// 'intel-sidebar-v2' key — v1 had stale '0' values from early testing
			const savedSidebar = localStorage.getItem('intel-sidebar-v2');
			if (savedSidebar !== null) setSidebarOpen(savedSidebar === '1');
			else setSidebarOpen(window.innerWidth > 768);
		} catch { /* storage unavailable */ }
		setHydrated(true);
	}, []);

	// Persist dark mode across sessions
	useEffect(() => {
		if (!hydrated) return;
		document.documentElement.classList.toggle('dark', dark);
		try { localStorage.setItem('intel-dark', dark ? '1' : '0'); } catch { /* */ }
	}, [dark, hydrated]);

	// Apply dark class immediately on first render before hydration completes
	useEffect(() => {
		try {
			const savedDark = localStorage.getItem('intel-dark');
			if (savedDark === '1') document.documentElement.classList.add('dark');
		} catch { /* */ }
	}, []);

	const persistView = (v: View) => {
		setView(v);
		try { sessionStorage.setItem('intel-view', v); } catch { /* */ }
	};

	const commitSearch = (q: string) => {
		const trimmed = q.trim();
		if (!trimmed) return;
		if (view !== 'search') setPreSearchView(view);
		setView('search');
		setSearchQuery(trimmed);
		setSearchInput(trimmed);
	};

	const clearSearch = (returnToPrev = false) => {
		setSearchInput('');
		setSearchQuery('');
		if (returnToPrev) setView(preSearchView);
	};

	const persistSelectedId = (id: number | null) => {
		setSelectedId(id);
		try { if (id !== null) sessionStorage.setItem('intel-selected-id', String(id)); } catch { /* */ }
	};

	const persistSidebar = (open: boolean) => {
		setSidebarOpen(open);
		try { localStorage.setItem('intel-sidebar-v2', open ? '1' : '0'); } catch { /* */ }
	};

	// Only close sidebar on mobile — on desktop it stays pinned
	const closeSidebarMobile = () => { if (window.innerWidth < 768) persistSidebar(false); };

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { setDrawer(null); setPreservedDrawer(null); }
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	const selected = briefings.find(b => b.id === selectedId) ?? null;
	const selectedArticles = selected ? articles.filter(a => a.trackingDate === selected.trackingDate) : [];
	const selectedClusters = selected ? clusters.filter(c => c.trackingDate === selected.trackingDate) : [];
	const preservedArticles = articles.filter(a => a.isPreserved);

	const hasMarkdown = selected?.aiAnalysisMarkdown && selected.aiAnalysisMarkdown !== 'articles';

	// Build display items for the briefing view:
	// - If clusters exist for this date → use them (new data)
	// - Fallback: wrap individual articles as single-item virtual clusters (old data)
	type DisplayItem = { cluster: IntelCluster; clusterArticles: IntelArticle[] };

	const displayItems: DisplayItem[] = selectedClusters.length > 0
		? selectedClusters.map(c => ({
			cluster: c,
			clusterArticles: selectedArticles.filter(a => a.clusterId === c.id),
		}))
		: selectedArticles.map(a => ({
			cluster: {
				id: a.id,
				trackingDate: a.trackingDate,
				title: a.title,
				summary: a.summary,
				category: a.category,
				sources: JSON.stringify(a.source ? [a.source] : []),
				createdAt: a.createdAt,
			} as IntelCluster,
			clusterArticles: [a],
		}));

	// Search filter — matches title, summary, source, or category tag
	function matchesBriefingSearch(item: DisplayItem) {
		if (!searchQuery) return true;
		const q = searchQuery.toLowerCase();
		return (
			(item.cluster.title?.toLowerCase().includes(q) ?? false) ||
			(item.cluster.summary?.toLowerCase().includes(q) ?? false) ||
			(item.cluster.category?.toLowerCase().includes(q) ?? false) ||
			item.clusterArticles.some(a => a.source?.toLowerCase().includes(q)) ||
			item.clusterArticles.some(a => a.category?.toLowerCase().includes(q))
		);
	}

	function matchesPreservedSearch(a: IntelArticle) {
		if (!searchQuery) return true;
		const q = searchQuery.toLowerCase();
		return (
			(a.title?.toLowerCase().includes(q) ?? false) ||
			(a.summary?.toLowerCase().includes(q) ?? false) ||
			(a.source?.toLowerCase().includes(q) ?? false)
		);
	}

	const visibleDisplayItems = displayItems.filter(matchesBriefingSearch);
	const visiblePreservedArticles = preservedArticles.filter(matchesPreservedSearch);

	// Global search across all dates
	const allDisplayItems: DisplayItem[] = clusters.length > 0
		? clusters.map(c => ({
			cluster: c,
			clusterArticles: articles.filter(a => a.clusterId === c.id),
		}))
		: articles.filter(a => !a.isPreserved).map(a => ({
			cluster: {
				id: a.id,
				trackingDate: a.trackingDate,
				title: a.title,
				summary: a.summary,
				category: a.category,
				sources: JSON.stringify(a.source ? [a.source] : []),
				createdAt: a.createdAt,
			} as IntelCluster,
			clusterArticles: [a],
		}));
	const searchResults = searchQuery
		? allDisplayItems.filter(matchesBriefingSearch)
		: [];

	// Feed data
	const feedDate = feed.length > 0 ? feed[0].trackingDate : null;
	const todayFeed = feedDate ? feed.filter(a => a.trackingDate === feedDate) : [];
	const feedBySource = todayFeed.reduce<Record<string, TempArticle[]>>((acc, a) => {
		if (!acc[a.source]) acc[a.source] = [];
		acc[a.source].push(a);
		return acc;
	}, {});

	// ── Sidebar ───────────────────────────────────────────────────────────────
	const sidebar = (
		<>
			<div
				onClick={() => persistSidebar(false)}
				className={[
					'fixed inset-0 z-20 bg-black/40 md:hidden transition-opacity duration-300 print:hidden',
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
						<h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 leading-snug tracking-tight">
							Chinese Provincial Press
						</h1>
						<p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Daily briefings · CST</p>
					</div>
					<div className="flex items-center gap-1">
						<button
							onClick={() => setDark(d => !d)}
							className="mt-1 p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
							aria-label="Toggle colour mode"
						>
							{dark ? <IconSun size={18} /> : <IconMoon size={18} />}
						</button>
						<button
							onClick={() => persistSidebar(false)}
							className="mt-1 p-2 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors md:hidden"
							aria-label="Close sidebar"
						>
							<IconX size={18} />
						</button>
					</div>
				</div>

				<nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4 min-h-0">
					{/* ── Preserved ── */}
					{(() => {
						const sq = searchInput.toLowerCase();
						const filtered = preservedArticles.filter(a =>
							!sq || (a.title?.toLowerCase().includes(sq)) || a.trackingDate.includes(sq)
						);
						if (preservedArticles.length === 0 && !sq) return null;
						if (sq && filtered.length === 0) return null;
						return (
							<div>
								<button
									onClick={() => { persistView('preserved'); clearSearch(); closeSidebarMobile(); }}
									className={[
										'w-full px-3 mb-1 flex items-center justify-between rounded-lg py-1.5 transition-colors',
										view === 'preserved' ? 'bg-amber-50 dark:bg-amber-500/10' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60',
									].join(' ')}
								>
									<span className="text-sm font-bold tracking-widest uppercase text-amber-600 dark:text-amber-500 flex items-center gap-1.5">
										<IconBookmarkFilled size={12} />
										Preserved ({filtered.length})
									</span>
									<IconChevronRight size={11} className="text-amber-500" />
								</button>
								{filtered.map(a => (
									<button
										key={a.id}
										onClick={() => { setPreservedDrawer(a); closeSidebarMobile(); }}
										className="w-full text-left rounded-lg px-3 py-2 mb-0.5 flex items-start gap-2.5 transition-all duration-100 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200 group"
									>
										<IconBookmark size={13} className="shrink-0 mt-0.5 text-amber-500" />
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium leading-snug truncate text-slate-800 dark:text-slate-200">{a.title ?? 'Untitled'}</p>
											<p className="text-[11px] text-slate-500 font-mono mt-0.5">{a.trackingDate}</p>
										</div>
										<IconChevronRight size={11} className="shrink-0 mt-1 opacity-0 group-hover:opacity-100 text-slate-400 transition-opacity" />
									</button>
								))}
								<div className="mt-3 border-t border-slate-200 dark:border-slate-800" />
							</div>
						);
					})()}

					{/* ── Today's Feed ── */}
					{(() => {
						const sq = searchInput.toLowerCase();
						const matches = !sq || 'feed'.includes(sq) || "today's feed".includes(sq)
							|| todayFeed.some(a => (a.titleEn ?? a.title).toLowerCase().includes(sq));
						if (!todayFeed.length || !matches) return null;
						return (
							<div>
								<button
									onClick={() => { persistView('feed'); clearSearch(); closeSidebarMobile(); }}
									className={[
										'w-full px-3 mb-1 flex items-center justify-between rounded-lg py-1.5 transition-colors',
										view === 'feed' ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60',
									].join(' ')}
								>
									<span className="text-sm font-bold tracking-widest uppercase text-emerald-600 dark:text-emerald-500 flex items-center gap-1.5">
										<IconLayoutGrid size={12} />
										Today's Feed ({todayFeed.length})
									</span>
									<IconChevronRight size={11} className="text-emerald-500" />
								</button>
								<div className="mt-2 border-t border-slate-200 dark:border-slate-800" />
							</div>
						);
					})()}

					{/* ── Briefings list ── */}
					{(() => {
						const sq = searchInput.toLowerCase();
						const filteredBriefings = briefings.filter(b => {
							if (!sq) return true;
							if (b.trackingDate.includes(sq)) return true;
							// also match if any cluster/article title for that date matches
							return clusters.some(c => c.trackingDate === b.trackingDate && c.title?.toLowerCase().includes(sq))
								|| articles.some(a => a.trackingDate === b.trackingDate && a.title?.toLowerCase().includes(sq));
						});
						return (
							<div>
								{briefings.length > 0 && (
									<p className="px-3 mb-1 text-sm font-bold tracking-widest uppercase text-slate-600 dark:text-slate-400">
										Briefings
									</p>
								)}
								{briefings.length === 0 ? (
									<p className="text-sm text-slate-500 text-center mt-8 px-4 leading-relaxed">No briefings on record yet.</p>
								) : filteredBriefings.length === 0 ? (
									<p className="text-sm text-slate-500 px-3 py-2">No results.</p>
								) : (
									filteredBriefings.map(b => {
										const isActive = selectedId === b.id && view === 'briefing';
										return (
											<button
												key={b.id}
												onClick={() => { persistSelectedId(b.id); persistView('briefing'); clearSearch(); setDrawer(null); closeSidebarMobile(); }}
												className={[
													'w-full text-left rounded-lg px-3 py-2.5 mb-0.5 flex items-center gap-3 transition-all duration-100',
													isActive
														? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
														: 'text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200',
												].join(' ')}
											>
												<IconCalendar size={16} className="shrink-0 text-slate-500" />
												<span className="flex-1 text-base font-mono font-medium tracking-wide">{b.trackingDate}</span>
												{isActive && <IconChevronRight size={13} className="text-red-600 dark:text-red-500 shrink-0" />}
											</button>
										);
									})
								)}
							</div>
						);
					})()}
				</nav>

				<div className="shrink-0 px-3 py-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
					<form onSubmit={e => { e.preventDefault(); commitSearch(searchInput); closeSidebarMobile(); }}>
						<div className="relative">
							<IconSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
							<input
								type="text"
								value={searchInput}
								onChange={e => setSearchInput(e.target.value)}
								placeholder="Search articles, dates, categories…"
								className="w-full pl-8 pr-16 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400 transition-colors"
							/>
							{(searchInput || searchQuery) && (
								<button
									type="button"
									onClick={() => clearSearch(true)}
									className="absolute right-9 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
								>
									<IconX size={13} />
								</button>
							)}
							<button
								type="submit"
								className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
								aria-label="Search"
							>
								<IconChevronRight size={16} />
							</button>
						</div>
					</form>
					<p className="text-[11px] text-slate-400 dark:text-slate-600 mt-1.5 px-1">
						{briefings.length} briefing{briefings.length !== 1 ? 's' : ''} on record{searchQuery ? ` · searching "${searchQuery}"` : ''}
					</p>
				</div>
			</aside>
		</>
	);

	// ── Mobile top bar ─────────────────────────────────────────────────────────
	const mobileTopBar = (
		<div className="md:hidden flex items-center gap-3 px-4 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0 print:hidden">
			<button
				onClick={() => persistSidebar(true)}
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

	// ── Empty state ────────────────────────────────────────────────────────────
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

	// ── Main layout ────────────────────────────────────────────────────────────
	return (
		<div className="flex h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
			{sidebar}

			<main className="flex-1 flex flex-col overflow-hidden md:overflow-y-auto print:overflow-visible print:h-auto">
				{mobileTopBar}
				<div className="flex-1 overflow-y-auto">

					{/* ── Search results view ────────────────────────────── */}
					{view === 'search' && (() => {
						// Group results by date, preserving most-recent-first order
						const byDate = searchResults.reduce<Record<string, DisplayItem[]>>((acc, item) => {
							const d = item.cluster.trackingDate;
							if (!acc[d]) acc[d] = [];
							acc[d].push(item);
							return acc;
						}, {});
						const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
						return (
							<div className="max-w-3xl mx-auto px-4 sm:px-10 py-10">
								<header className="mb-8 pb-4 border-b border-slate-200 dark:border-slate-800">
									<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500 mb-2 flex items-center gap-1.5">
										<IconSearch size={13} />
										Search Results
									</p>
									<h2 className="font-serif text-4xl text-slate-900 dark:text-slate-100 tracking-tight">
										{searchQuery ? `"${searchQuery}"` : 'All Articles'}
									</h2>
									<p className="text-sm text-slate-600 dark:text-slate-400 mt-2">
										{searchResults.length} result{searchResults.length !== 1 ? 's' : ''} across {dates.length} briefing{dates.length !== 1 ? 's' : ''}
									</p>
									<form className="mt-4" onSubmit={e => { e.preventDefault(); commitSearch(searchInput); }}>
										<div className="flex gap-2">
											<div className="relative flex-1">
												<IconSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
												<input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Search again…" className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400 transition-colors" />
												{(searchInput || searchQuery) && <button type="button" onClick={() => clearSearch(true)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><IconX size={13} /></button>}
											</div>
											<button type="submit" className="shrink-0 px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors">Search</button>
										</div>
									</form>
								</header>
								{searchResults.length === 0 ? (
									<div className="text-center py-16">
										<IconSearch size={40} className="mx-auto text-slate-200 dark:text-slate-700 mb-4" />
										<p className="text-slate-500">No articles match your search.</p>
									</div>
								) : (
									<div className="space-y-10">
										{dates.map(date => (
											<div key={date}>
												<div className="flex items-center gap-3 mb-4">
													<p className="text-sm font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400 font-mono">{date}</p>
													<div className="flex-1 h-px bg-slate-200 dark:border-slate-800 bg-slate-200 dark:bg-slate-800" />
													<span className="text-xs text-slate-400 font-mono">{byDate[date].length} article{byDate[date].length !== 1 ? 's' : ''}</span>
												</div>
												<div className="space-y-4">
													{byDate[date].map(({ cluster, clusterArticles }) => (
														<ClusterCard
															key={cluster.id}
															cluster={cluster}
															clusterArticles={clusterArticles}
															onOpen={() => setDrawer({ cluster, articles: clusterArticles })}
															onPreserveAll={ids => startTransition(() => togglePreserveCluster(ids, clusterArticles.every(a => !!a.isPreserved)))}
															onDeleteAll={ids => startTransition(() => deleteCluster(ids))}
														/>
													))}
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						);
					})()}

					{/* ── Preserved view ─────────────────────────────────── */}
					{view === 'preserved' && (
						<div className="max-w-3xl mx-auto px-4 sm:px-10 py-10">
							<header className="mb-8 pb-6 border-b border-slate-200 dark:border-slate-800">
								<p className="text-xs font-bold tracking-widest uppercase text-amber-600 dark:text-amber-500 mb-2 flex items-center gap-1.5">
									<IconArchive size={13} />
									Preserved Articles
								</p>
								<h2 className="font-serif text-4xl text-slate-900 dark:text-slate-100 tracking-tight">Archive</h2>
								<p className="text-sm text-slate-600 dark:text-slate-400 mt-3">
									{preservedArticles.length} article{preservedArticles.length !== 1 ? 's' : ''} preserved · exempt from 30-day cleanup
								</p>
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
									{visiblePreservedArticles.map(a => (
										<ArticleCard
											key={a.id}
											article={a}
											showDate
											onPreserve={(id, cur) => startTransition(() => togglePreserve(id, cur))}
											onDelete={id => startTransition(() => deleteArticle(id))}
											onReadFull={a => setPreservedDrawer(a)}
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
								<p className="text-base text-slate-600 dark:text-slate-400 mt-3">
									All {todayFeed.length} scraped articles · titles AI-translated ·{' '}
									<span className="text-emerald-600 dark:text-emerald-400 font-medium">
										{todayFeed.filter(a => a.isImportant).length} flagged for full analysis
									</span>
									{' '}· deleted at next morning run
								</p>
								<p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
									Click any source link to read the original. AI reasoning shown below each title.
								</p>
							</header>
							{Object.entries(feedBySource).map(([source, arts]) => (
								<div key={source} className="mb-10">
									<div className="flex items-center gap-3 mb-4">
										<h3 className="text-base font-bold tracking-widest uppercase text-slate-600 dark:text-slate-400">
											{source}
										</h3>
										<div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
										<span className="text-xs font-mono text-slate-500">{arts.length} articles</span>
									</div>
									<div className="space-y-3">
										{arts.map(a => {
											// FK first; fallback finds the intel_article row that actually has cluster_id set
											// (multiple runs create duplicate rows — we want the one with cluster_id, not just first)
											const matchedCluster = a.isImportant
												? (a.clusterId
													? clusters.find(c => c.id === a.clusterId)
													: (() => {
														const art = articles.find(x => x.url === a.url && x.clusterId)
															?? articles.find(x => a.titleEn && x.title === a.titleEn && x.clusterId)
															?? articles.find(x => a.title && x.title === a.title && x.clusterId);
														return art?.clusterId ? clusters.find(c => c.id === art.clusterId) : undefined;
													})())
												: undefined;
											const clusterArticles = matchedCluster ? articles.filter(art => art.clusterId === matchedCluster.id) : [];

											return (
											<div key={a.id} className={['bg-white dark:bg-slate-900 border rounded-xl px-4 py-4 sm:px-5 sm:py-4 flex items-start gap-3 sm:gap-4', a.isImportant ? 'border-emerald-200 dark:border-emerald-800/50' : 'border-slate-200 dark:border-slate-800'].join(' ')}>
												<div className="mt-1 shrink-0">
													{a.isImportant ? (
														<span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
															<IconCheck size={13} strokeWidth={2.5} />
														</span>
													) : (
														<span className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600">
															<IconMinus size={13} strokeWidth={2.5} />
														</span>
													)}
												</div>
												<div className="flex-1 min-w-0">
													<div className="flex items-start gap-2">
														<p className={['text-base font-medium leading-snug flex-1', a.isImportant ? 'text-slate-900 dark:text-slate-100' : 'text-slate-800 dark:text-slate-400'].join(' ')}>
															{a.titleEn ?? a.title}
														</p>
														{a.parseType === 'rss' && (
															<span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30 shrink-0 mt-0.5">
																RSS
															</span>
														)}
													</div>
													{a.importanceReason && (
														<p className={['text-sm mt-1.5 leading-relaxed', a.isImportant ? 'text-emerald-700 dark:text-emerald-500' : 'text-slate-700 dark:text-slate-500'].join(' ')}>
															{a.isImportant ? '✓ ' : '— '}{a.importanceReason}
														</p>
													)}
													{/* Quick-access row for important articles */}
													{!!a.isImportant && (
														<div className="flex flex-wrap items-center gap-3 mt-2.5">
															{matchedCluster ? (
																<button
																	onClick={() => setDrawer({ cluster: matchedCluster, articles: clusterArticles })}
																	className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors py-0.5"
																>
																	<IconArticle size={14} />
																	View Full Analysis
																</button>
															) : (
																<span className="text-sm text-slate-400 dark:text-slate-600 italic">Not yet analysed</span>
															)}
															{safeUrl(a.url) && (
																<a href={safeUrl(a.url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-slate-400 dark:text-slate-600 hover:text-blue-500 dark:hover:text-blue-400 transition-colors py-0.5">
																	<IconExternalLink size={13} />
																	Source
																</a>
															)}
														</div>
													)}
												</div>
												{/* For skipped articles, show the source link on the right */}
												{!a.isImportant && safeUrl(a.url) && (
													<a href={safeUrl(a.url)!} target="_blank" rel="noopener noreferrer" className="shrink-0 mt-1 p-1.5 -mr-1 text-slate-300 dark:text-slate-700 hover:text-blue-500 dark:hover:text-blue-400 transition-colors" title="Open original article">
														<IconExternalLink size={16} />
													</a>
												)}
											</div>
											);
										})}
									</div>
								</div>
							))}
						</div>
					)}

					{/* ── Daily briefing view ─────────────────────────────── */}
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
										<p className="text-sm text-slate-600 dark:text-slate-400">
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
									{displayItems.length > 0 && (
										<form className="mt-4 print:hidden" onSubmit={e => { e.preventDefault(); commitSearch(searchInput); }}>
											<div className="flex gap-2">
												<div className="relative flex-1">
													<IconSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
													<input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Search all articles, categories… (Enter)" className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400 transition-colors" />
													{(searchInput || searchQuery) && <button type="button" onClick={() => clearSearch(true)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><IconX size={13} /></button>}
												</div>
												<button type="submit" className="shrink-0 px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors">Search</button>
											</div>
										</form>
									)}
								</header>

								{displayItems.length > 0 ? (
									visibleDisplayItems.length === 0 ? (
										<p className="text-sm text-slate-500 text-center py-12">No articles match your search.</p>
									) : (
										<div className="space-y-4">
											{visibleDisplayItems.map(({ cluster, clusterArticles }) => (
												<ClusterCard
													key={cluster.id}
													cluster={cluster}
													clusterArticles={clusterArticles}
													onOpen={() => setDrawer({ cluster, articles: clusterArticles })}
													onPreserveAll={ids => startTransition(() => togglePreserveCluster(ids, clusterArticles.every(a => !!a.isPreserved)))}
													onDeleteAll={ids => startTransition(() => deleteCluster(ids))}
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

			{/* Cluster drawer — briefing view */}
			<ClusterDrawer
				state={drawer}
				onClose={() => setDrawer(null)}
				onPreserveAll={(ids, cur) => {
					startTransition(() => togglePreserveCluster(ids, cur));
					setDrawer(prev => prev ? {
						...prev,
						articles: prev.articles.map(a => ({ ...a, isPreserved: cur ? 0 : 1 })),
					} : null);
				}}
				onDeleteAll={ids => {
					startTransition(() => deleteCluster(ids));
					setDrawer(null);
				}}
				onUnpreserveAndDelete={id => {
					startTransition(() => unpreserveAndDelete(id));
					setDrawer(prev => prev ? { ...prev, articles: prev.articles.filter(a => a.id !== id) } : null);
				}}
			/>

			{/* Article drawer — preserved view (single article) */}
			<ArticleDrawer
				article={preservedDrawer}
				onClose={() => setPreservedDrawer(null)}
				onPreserve={(id, cur) => {
					startTransition(() => togglePreserve(id, cur));
					setPreservedDrawer(prev => prev ? { ...prev, isPreserved: cur ? 0 : 1 } : null);
				}}
				onUnpreserveAndDelete={id => {
					startTransition(() => unpreserveAndDelete(id));
					setPreservedDrawer(null);
				}}
			/>
		</div>
	);
}

// ─── Cluster card ─────────────────────────────────────────────────────────────

interface ClusterCardProps {
	cluster: IntelCluster;
	clusterArticles: IntelArticle[];
	onOpen: () => void;
	onPreserveAll: (ids: number[]) => void;
	onDeleteAll: (ids: number[]) => void;
}

function ClusterCard({ cluster, clusterArticles, onOpen, onPreserveAll, onDeleteAll }: ClusterCardProps) {
	const sources: string[] = (() => { try { return JSON.parse(cluster.sources ?? '[]'); } catch { return []; } })();
	const isMultiSource = clusterArticles.length > 1;
	const isHigh = cluster.summary?.includes('[HIGH]');
	const anyPreserved = clusterArticles.some(a => a.isPreserved);
	const allPreserved = clusterArticles.length > 0 && clusterArticles.every(a => a.isPreserved);
	const ids = clusterArticles.map(a => a.id);

	return (
		<Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm py-0">
			<CardHeader className="pt-5 pb-2">
				<div className="flex items-start justify-between gap-3">
					<div className="flex-1 min-w-0">
						<div className="flex flex-wrap items-center gap-1.5 mb-2">
							{cluster.category && (
								<span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle(cluster.category)}`}>
									{cluster.category}
								</span>
							)}
							{sources.map(s => (
								<span key={s} className="text-[11px] text-slate-500 dark:text-slate-500 font-mono">{s}</span>
							))}
							{isMultiSource && (
								<span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
									<IconBuildings size={10} />
									{clusterArticles.length} sources
								</span>
							)}
						</div>
						<CardTitle className="font-serif text-xl text-slate-900 dark:text-slate-100 leading-snug">
							{cluster.title ?? 'Untitled'}
						</CardTitle>
					</div>
					{isHigh && (
						<Badge variant="destructive" className="shrink-0 text-xs px-2 py-0.5 mt-0.5">HIGH</Badge>
					)}
				</div>
			</CardHeader>

			<CardContent className="pt-0 pb-4 space-y-3">
				{cluster.summary && (
					<p className="text-base text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-2 sm:line-clamp-none">
						{cluster.summary.replace(/\[HIGH\]/g, '').trim()}
					</p>
				)}

				<div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
					<button
						onClick={onOpen}
						className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors py-1"
					>
						<IconArticle size={16} />
						{isMultiSource ? `${clusterArticles.length} Publisher Perspectives` : 'Read Full Article'}
					</button>

					<div className="flex items-center gap-0.5 print:hidden">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPreserveAll(ids)}
							className={[
								'h-8 px-2 sm:px-3 text-sm gap-1.5',
								anyPreserved
									? 'text-amber-600 dark:text-amber-400'
									: 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400',
							].join(' ')}
							title={allPreserved ? 'Unpreserve all' : 'Preserve all'}
						>
							{anyPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							<span className="hidden sm:inline">{allPreserved ? 'Preserved' : anyPreserved ? 'Partial' : 'Preserve'}</span>
						</Button>

						<Button
							variant="ghost"
							size="sm"
							onClick={() => !anyPreserved && onDeleteAll(ids)}
							disabled={anyPreserved}
							className={[
								'h-8 px-2 sm:px-3 text-sm gap-1.5',
								anyPreserved
									? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
									: 'text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400',
							].join(' ')}
							title={anyPreserved ? 'Unpreserve before deleting' : 'Delete'}
						>
							{anyPreserved ? <IconLock size={15} /> : <IconTrash size={15} />}
							<span className="hidden sm:inline">{anyPreserved ? 'Locked' : 'Delete'}</span>
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Cluster drawer ───────────────────────────────────────────────────────────

interface ClusterDrawerProps {
	state: DrawerState | null;
	onClose: () => void;
	onPreserveAll: (ids: number[], currentlyPreserved: boolean) => void;
	onDeleteAll: (ids: number[]) => void;
	onUnpreserveAndDelete: (id: number) => void;
}

function ClusterDrawer({ state, onClose, onPreserveAll, onDeleteAll, onUnpreserveAndDelete }: ClusterDrawerProps) {
	const [chineseFor, setChineseFor] = useState<number | null>(null);
	const [localArticles, setLocalArticles] = useState<IntelArticle[]>([]);
	const open = state !== null;

	useEffect(() => {
		setChineseFor(null);
		setLocalArticles(state?.articles ?? []);
	}, [state?.cluster.id]);

	// Sync if parent updates articles (e.g. preserve-all)
	useEffect(() => {
		if (state?.articles) setLocalArticles(state.articles);
	}, [state?.articles]);

	const { cluster } = state ?? { cluster: null };
	const articles = localArticles;
	const sources: string[] = (() => { try { return JSON.parse(cluster?.sources ?? '[]'); } catch { return []; } })();
	const isMultiSource = articles.length > 1;
	const anyPreserved = articles.some(a => a.isPreserved);
	const allPreserved = articles.length > 0 && articles.every(a => a.isPreserved);
	const ids = articles.map(a => a.id);

	return (
		<>
			<div
				onClick={onClose}
				className={['fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity duration-300', open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'].join(' ')}
			/>
			<div className={['fixed top-0 right-0 z-50 h-full w-full sm:w-[52%] sm:min-w-[480px] bg-white dark:bg-slate-900 shadow-2xl flex flex-col transition-transform duration-300 ease-in-out', open ? 'translate-x-0' : 'translate-x-full'].join(' ')}>

				{/* Drawer header */}
				<div className="flex items-center justify-between px-5 sm:px-7 py-5 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<div>
						<div className="flex items-center gap-2 mb-0.5">
							<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500">
								{isMultiSource ? 'Multi-Source Story' : 'Full Article'}
							</p>
							{cluster?.category && (
								<span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle(cluster.category)}`}>
									{cluster.category}
								</span>
							)}
						</div>
						<p className="text-sm text-slate-600 dark:text-slate-400">
							{isMultiSource ? `${sources.join(' · ')} · ${articles.length} perspectives` : (sources[0] ?? '') + ' · English analysis + translation'}
						</p>
					</div>
					<button
						onClick={onClose}
						className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
						aria-label="Close"
					>
						<IconX size={18} />
					</button>
				</div>

				{/* Drawer body */}
				<div className="flex-1 overflow-y-auto px-5 sm:px-7 py-7 space-y-8">
					{cluster && (
						<>
							{/* Synthesised headline + combined summary */}
							<div className="space-y-3">
								<h2 className="font-serif text-2xl text-slate-900 dark:text-slate-100 leading-snug">
									{cluster.title}
								</h2>
								{isMultiSource && (
									<div className="flex flex-wrap gap-1.5">
										{sources.map(s => (
											<span key={s} className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
												<IconBuildings size={10} />
												{s}
											</span>
										))}
									</div>
								)}
								{cluster.summary && (
									<div>
										<p className="text-xs font-bold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-2">
											{isMultiSource ? 'Combined Intelligence Assessment' : 'Geopolitical Summary'}
										</p>
										<p className="text-base text-slate-700 dark:text-slate-200 leading-relaxed">
											{cluster.summary.replace(/\[HIGH\]/g, '').trim()}
										</p>
									</div>
								)}
							</div>

							{/* Publisher perspectives */}
							<div>
								<p className="text-sm font-bold tracking-widest uppercase text-slate-600 dark:text-slate-400 mb-4 flex items-center gap-2">
									<IconBuildings size={12} />
									{isMultiSource ? `Publisher Perspectives (${articles.length})` : 'Full Article'}
								</p>

								<div className="space-y-4">
									{articles.map(article => (
										<div
											key={article.id}
											className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 overflow-hidden"
										>
											{/* Article header */}
											<div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
												<div className="flex items-center gap-2 min-w-0">
													<span className="text-xs font-semibold text-slate-600 dark:text-slate-300 shrink-0">
														{article.source}
													</span>
													{article.parseType === 'rss' && (
														<span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30 shrink-0">
															RSS
														</span>
													)}
													{safeUrl(article.url) && (
														<a
															href={safeUrl(article.url)!}
															target="_blank"
															rel="noopener noreferrer"
															className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 truncate"
														>
															<IconExternalLink size={11} className="shrink-0" />
															<span className="truncate">Source</span>
														</a>
													)}
												</div>
												<div className="flex items-center gap-2 shrink-0">
													{article.fullText && (
														<button
															onClick={() => setChineseFor(chineseFor === article.id ? null : article.id)}
															className={[
																'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors',
																chineseFor === article.id
																	? 'bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-400'
																	: 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300',
															].join(' ')}
														>
															<IconLanguage size={11} />
															{chineseFor === article.id ? 'EN' : '中文'}
														</button>
													)}
													<button
														onClick={() => {
															const next = article.isPreserved ? 0 : 1;
															setLocalArticles(prev => prev.map(a => a.id === article.id ? { ...a, isPreserved: next } : a));
															togglePreserve(article.id, article.isPreserved ?? 0);
														}}
														className={['p-1 rounded transition-colors', article.isPreserved ? 'text-amber-500' : 'text-slate-300 dark:text-slate-600 hover:text-amber-500'].join(' ')}
														title={article.isPreserved ? 'Unpreserve' : 'Preserve this source'}
													>
														{article.isPreserved ? <IconBookmarkFilled size={14} /> : <IconBookmark size={14} />}
													</button>
												</div>
											</div>

											{/* Article body */}
											<div className="px-5 py-4 space-y-3">
												{isMultiSource && (
													<h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 leading-snug">
														{article.title}
													</h3>
												)}

												{chineseFor === article.id ? (
													<div className="rounded-lg bg-amber-50/60 dark:bg-slate-900 border border-amber-200 dark:border-amber-500/20 p-4">
														<pre className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap break-words font-mono">
															{article.fullText}
														</pre>
													</div>
												) : (
													<>
														{article.summary && (
															<p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
																{article.summary.replace(/\[HIGH\]/g, '').trim()}
															</p>
														)}
														{article.parseType === 'rss' ? (
															<div className="border-t border-slate-200 dark:border-slate-800 pt-3">
																<div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-4 py-3 space-y-2">
																	<p className="text-xs font-bold tracking-widest uppercase text-amber-700 dark:text-amber-400">
																		RSS excerpt only
																	</p>
																	<p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
																		Full article text was not available — only the RSS feed excerpt was scraped. Visit the original to read the complete content; use your browser's built-in translate feature for Chinese.
																	</p>
																	{safeUrl(article.url) && (
																		<a
																			href={safeUrl(article.url)!}
																			target="_blank"
																			rel="noopener noreferrer"
																			className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 transition-colors"
																		>
																			<IconExternalLink size={13} />
																			Read full article →
																		</a>
																	)}
																</div>
																{article.fullTextEn && (
																	<p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mt-3">
																		{article.fullTextEn}
																	</p>
																)}
															</div>
														) : article.fullTextEn ? (
															<div className="border-t border-slate-200 dark:border-slate-800 pt-3">
																<p className="text-xs font-bold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-2">
																	Full Translation
																</p>
																<p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
																	{article.fullTextEn}
																</p>
															</div>
														) : null}
													</>
												)}

												{/* Per-article delete (only if not preserved) */}
												{!article.isPreserved && isMultiSource && (
													<div className="pt-1">
														<button
															onClick={() => onUnpreserveAndDelete(article.id)}
															className="text-[11px] text-slate-400 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors flex items-center gap-1"
														>
															<IconTrash size={11} />
															Remove this source from cluster
														</button>
													</div>
												)}
											</div>
										</div>
									))}
								</div>
							</div>
						</>
					)}
				</div>

				{/* Drawer footer */}
				{cluster && (
					<div className="shrink-0 px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPreserveAll(ids, allPreserved)}
							className={[
								'gap-2 text-sm',
								anyPreserved
									? 'text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300'
									: 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400',
							].join(' ')}
						>
							{anyPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							{allPreserved ? 'Preserved — click to unpreserve all' : anyPreserved ? 'Preserve remaining' : 'Preserve all'}
						</Button>

						{!anyPreserved && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => onDeleteAll(ids)}
								className="gap-2 text-sm text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400"
							>
								<IconTrash size={15} />
								Delete cluster
							</Button>
						)}
					</div>
				)}
			</div>
		</>
	);
}

// ─── Article card (preserved view only) ──────────────────────────────────────

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
						{(article.category || article.source || showDate) && (
							<div className="flex flex-wrap items-center gap-1.5 mb-2">
								{article.category && (
									<span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle(article.category)}`}>
										{article.category}
									</span>
								)}
								{article.source && <span className="text-[11px] text-slate-500 dark:text-slate-500 font-mono">{article.source}</span>}
								{article.parseType === 'rss' && (
									<span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-500/30">
										RSS
									</span>
								)}
								{showDate && <span className="text-[11px] text-slate-500 dark:text-slate-500 font-mono">· {article.trackingDate}</span>}
							</div>
						)}
						<CardTitle className="font-serif text-xl text-slate-900 dark:text-slate-100 leading-snug">
							{article.title ?? 'Untitled Article'}
						</CardTitle>
					</div>
					{isHigh && <Badge variant="destructive" className="shrink-0 text-xs px-2 py-0.5 mt-0.5">HIGH</Badge>}
				</div>
			</CardHeader>
			<CardContent className="pt-0 pb-4 space-y-3">
				{article.summary && (
					<p className="text-base text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-2 sm:line-clamp-none">
						{article.summary.replace(/\[HIGH\]/g, '').trim()}
					</p>
				)}
				<div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
					<div className="flex items-center gap-3">
						<button
							onClick={() => onReadFull(article)}
							className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors py-1"
						>
							<IconArticle size={16} />
							Read Full Article
						</button>
						{safeUrl(article.url) && (
							<a href={safeUrl(article.url)!} target="_blank" rel="noopener noreferrer" className="hidden sm:inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors hover:underline underline-offset-2">
								<IconExternalLink size={14} />
								Source
							</a>
						)}
					</div>
					<div className="flex items-center gap-0.5 print:hidden">
						<Button variant="ghost" size="sm" onClick={() => onPreserve(article.id, article.isPreserved ?? 0)} className={['h-8 px-2 sm:px-3 text-sm gap-1.5', article.isPreserved ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400'].join(' ')} title={article.isPreserved ? 'Unpreserve' : 'Preserve'}>
							{article.isPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							<span className="hidden sm:inline">{article.isPreserved ? 'Preserved' : 'Preserve'}</span>
						</Button>
						<Button variant="ghost" size="sm" onClick={() => !article.isPreserved && onDelete(article.id)} disabled={!!article.isPreserved} className={['h-8 px-2 sm:px-3 text-sm gap-1.5', article.isPreserved ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400'].join(' ')} title={article.isPreserved ? 'Unpreserve before deleting' : 'Delete'}>
							{article.isPreserved ? <IconLock size={15} /> : <IconTrash size={15} />}
							<span className="hidden sm:inline">{article.isPreserved ? 'Locked' : 'Delete'}</span>
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

// ─── Article drawer (preserved view) ─────────────────────────────────────────

interface ArticleDrawerProps {
	article: IntelArticle | null;
	onClose: () => void;
	onPreserve: (id: number, current: number) => void;
	onUnpreserveAndDelete: (id: number) => void;
}

function ArticleDrawer({ article, onClose, onPreserve, onUnpreserveAndDelete }: ArticleDrawerProps) {
	const [showChinese, setShowChinese] = useState(false);
	const open = article !== null;
	useEffect(() => { setShowChinese(false); }, [article?.id]);

	return (
		<>
			<div onClick={onClose} className={['fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity duration-300', open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'].join(' ')} />
			<div className={['fixed top-0 right-0 z-50 h-full w-full sm:w-[48%] sm:min-w-[440px] bg-white dark:bg-slate-900 shadow-2xl flex flex-col transition-transform duration-300 ease-in-out', open ? 'translate-x-0' : 'translate-x-full'].join(' ')}>
				<div className="flex items-center justify-between px-5 sm:px-7 py-5 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<div>
						<div className="flex items-center gap-2 mb-0.5">
							<p className="text-xs font-bold tracking-widest uppercase text-red-600 dark:text-red-500">Full Article</p>
							{article?.category && <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle(article.category)}`}>{article.category}</span>}
						</div>
						<p className="text-sm text-slate-600 dark:text-slate-400">{article?.source ? `${article.source} · ` : ''}English analysis + translation</p>
					</div>
					<div className="flex items-center gap-2">
						{article?.fullText && (
							<button
								onClick={() => setShowChinese(v => !v)}
								className={['inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors', showChinese ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-400' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300'].join(' ')}
							>
								<IconLanguage size={13} />
								{showChinese ? 'Show English' : '中文 Source'}
							</button>
						)}
						<button onClick={onClose} className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" aria-label="Close">
							<IconX size={18} />
						</button>
					</div>
				</div>

				<div className="flex-1 overflow-y-auto px-5 sm:px-7 py-7 space-y-7">
					{article && (
						<>
							<div className="space-y-2">
								<h2 className="font-serif text-2xl text-slate-900 dark:text-slate-100 leading-snug">{article.title}</h2>
								{safeUrl(article.url) && (
									<a href={safeUrl(article.url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 break-all">
										<IconExternalLink size={14} className="shrink-0" />
										{article.url}
									</a>
								)}
							</div>
							{showChinese ? (
								<div>
									<p className="text-xs font-bold tracking-widest uppercase text-amber-600 dark:text-amber-500 mb-4">Source Text (Chinese)</p>
									<div className="rounded-xl bg-amber-50/60 dark:bg-slate-950 border border-amber-200 dark:border-amber-500/20 p-5">
										<pre className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap break-words font-mono">{article.fullText}</pre>
									</div>
								</div>
							) : (
								<>
									<div>
										<p className="text-sm font-bold tracking-widest uppercase text-slate-600 dark:text-slate-400 mb-3">Geopolitical Summary</p>
										<p className="text-base text-slate-700 dark:text-slate-200 leading-relaxed">{article.summary?.replace(/\[HIGH\]/g, '').trim() ?? 'No summary available.'}</p>
									</div>
									{article.parseType === 'rss' ? (
										<div className="rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-5 py-4 space-y-3">
											<p className="text-xs font-bold tracking-widest uppercase text-amber-700 dark:text-amber-400">RSS excerpt only</p>
											<p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">Full article text was not available — only the RSS feed excerpt was scraped. Visit the original article to read the complete content; use your browser&apos;s built-in translate feature for Chinese.</p>
											{safeUrl(article.url) && (
												<a href={safeUrl(article.url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 transition-colors">
													<IconExternalLink size={13} />
													Read full article →
												</a>
											)}
											{article.fullTextEn && (
												<p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed pt-1 border-t border-amber-200 dark:border-amber-500/20">{article.fullTextEn}</p>
											)}
										</div>
									) : article.fullTextEn ? (
										<div>
											<p className="text-sm font-bold tracking-widest uppercase text-slate-600 dark:text-slate-400 mb-3">Full Article (English Translation)</p>
											<p className="text-base text-slate-700 dark:text-slate-300 leading-relaxed">{article.fullTextEn}</p>
										</div>
									) : (
										<div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 px-5 py-4">
											<p className="text-sm text-slate-600 dark:text-slate-400">Full English translation not available. Toggle to <strong>中文 Source</strong> to read the original.</p>
										</div>
									)}
								</>
							)}
						</>
					)}
				</div>

				{article && (
					<div className="shrink-0 px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
						<Button variant="ghost" size="sm" onClick={() => onPreserve(article.id, article.isPreserved ?? 0)} className={['gap-2 text-sm', article.isPreserved ? 'text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300' : 'text-slate-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400'].join(' ')}>
							{article.isPreserved ? <IconBookmarkFilled size={15} /> : <IconBookmark size={15} />}
							{article.isPreserved ? 'Preserved — click to unpreserve' : 'Preserve'}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => onUnpreserveAndDelete(article.id)} className="gap-2 text-sm text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400">
							<IconTrash size={15} />
							{article.isPreserved ? 'Unpreserve & Delete' : 'Delete'}
						</Button>
					</div>
				)}
			</div>
		</>
	);
}
