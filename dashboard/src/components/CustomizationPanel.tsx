'use client';

import { useState, useEffect, useCallback } from 'react';
import {
	IconAdjustments,
	IconX,
	IconRotate,
	IconLoader2,
} from '@tabler/icons-react';

// ── Font catalogue ────────────────────────────────────────────────────────────

interface FontOption {
	id: string;
	label: string;
	category: 'Sans' | 'Serif' | 'Slab' | 'Mono';
	cssFamily: string;
	/** Exact family name passed to document.fonts.load(). null = already available (var/system). */
	familyName: string | null;
	googleUrl: string | null;
}

const FONTS: FontOption[] = [
	{ id: 'inter',        label: 'Inter',          category: 'Sans',  cssFamily: "'Inter', sans-serif",                familyName: 'Inter',           googleUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' },
	{ id: 'space-grotesk',label: 'Space Grotesk',  category: 'Sans',  cssFamily: "'Space Grotesk', sans-serif",        familyName: 'Space Grotesk',   googleUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap' },
	{ id: 'dm-serif',     label: 'DM Serif',        category: 'Serif', cssFamily: "'DM Serif Display', serif",          familyName: 'DM Serif Display', googleUrl: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&display=swap' },
	{ id: 'lora',         label: 'Lora',            category: 'Serif', cssFamily: "'Lora', Georgia, serif",             familyName: 'Lora',            googleUrl: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&display=swap' },
	{ id: 'merriweather', label: 'Merriweather',    category: 'Serif', cssFamily: "'Merriweather', Georgia, serif",     familyName: 'Merriweather',    googleUrl: 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap' },
	{ id: 'playfair',     label: 'Playfair',        category: 'Serif', cssFamily: "'Playfair Display', Georgia, serif", familyName: 'Playfair Display', googleUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap' },
	{ id: 'crimson',      label: 'Crimson',         category: 'Serif', cssFamily: "'Crimson Text', Georgia, serif",     familyName: 'Crimson Text',    googleUrl: 'https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600&display=swap' },
	{ id: 'bitter',       label: 'Bitter',          category: 'Slab',  cssFamily: "'Bitter', Georgia, serif",           familyName: 'Bitter',          googleUrl: 'https://fonts.googleapis.com/css2?family=Bitter:wght@400;700&display=swap' },
	{ id: 'geist-mono',   label: 'Geist Mono',      category: 'Mono',  cssFamily: "'Geist Mono', monospace",            familyName: 'Geist Mono',      googleUrl: 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&display=swap' },
	{ id: 'jetbrains',    label: 'JetBrains',       category: 'Mono',  cssFamily: "'JetBrains Mono', monospace",        familyName: 'JetBrains Mono',  googleUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap' },
];

// ── Preference shape ──────────────────────────────────────────────────────────

type FontSizeId     = 'xs' | 'sm' | 'base' | 'lg' | 'xl';
type LineHeightId   = 'compact' | 'comfortable' | 'spacious';
type ReadingWidthId = 'narrow' | 'medium' | 'wide';
type AccentId       = 'red' | 'blue' | 'amber' | 'emerald' | 'violet';

interface Prefs {
	fontId:       string;
	fontSize:     FontSizeId;
	lineHeight:   LineHeightId;
	readingWidth: ReadingWidthId;
	accent:       AccentId;
}

const DEFAULTS: Prefs = {
	fontId:       'inter',
	fontSize:     'base',
	lineHeight:   'comfortable',
	readingWidth: 'medium',
	accent:       'red',
};

const PREFS_KEY = 'intel-reading-prefs-v1';

const FONT_SIZES: { id: FontSizeId; label: string; title: string }[] = [
	{ id: 'xs',   label: 'XS', title: 'Extra small' },
	{ id: 'sm',   label: 'S',  title: 'Small' },
	{ id: 'base', label: 'M',  title: 'Medium (default)' },
	{ id: 'lg',   label: 'L',  title: 'Large' },
	{ id: 'xl',   label: 'XL', title: 'Extra large' },
];

const LINE_HEIGHTS: { id: LineHeightId; label: string }[] = [
	{ id: 'compact',     label: 'Compact' },
	{ id: 'comfortable', label: 'Normal' },
	{ id: 'spacious',    label: 'Spacious' },
];

const READING_WIDTHS: { id: ReadingWidthId; label: string }[] = [
	{ id: 'narrow', label: 'Narrow' },
	{ id: 'medium', label: 'Medium' },
	{ id: 'wide',   label: 'Wide' },
];

const ACCENTS: { id: AccentId; color: string; darkColor: string; label: string }[] = [
	{ id: 'red',     color: '#dc2626', darkColor: '#ef4444', label: 'Red' },
	{ id: 'blue',    color: '#2563eb', darkColor: '#60a5fa', label: 'Blue' },
	{ id: 'amber',   color: '#d97706', darkColor: '#fbbf24', label: 'Amber' },
	{ id: 'emerald', color: '#059669', darkColor: '#34d399', label: 'Emerald' },
	{ id: 'violet',  color: '#7c3aed', darkColor: '#a78bfa', label: 'Violet' },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function loadPrefs(): Prefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY);
		if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
	} catch { /* storage unavailable */ }
	return DEFAULTS;
}

function savePrefs(p: Prefs) {
	try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* */ }
}

function applyPrefs(p: Prefs, font: FontOption) {
	const r = document.documentElement;
	// Font family — must be set via JS property (value is a string, not a token)
	r.style.setProperty('--reading-font-family', font.cssFamily);
	// Size, line-height, width, accent — via data attributes (CSS handles them)
	if (p.fontSize === 'base') r.removeAttribute('data-rs'); else r.setAttribute('data-rs', p.fontSize);
	if (p.lineHeight === 'comfortable') r.removeAttribute('data-rlh'); else r.setAttribute('data-rlh', p.lineHeight);
	if (p.readingWidth === 'medium') r.removeAttribute('data-rw'); else r.setAttribute('data-rw', p.readingWidth);
	if (p.accent === 'red') r.removeAttribute('data-accent'); else r.setAttribute('data-accent', p.accent);
}

// Tracks link tags we've already injected (avoids double-inject)
const injectedUrls = new Set<string>();
// Tracks fonts confirmed usable via document.fonts.load() — skip loading state for these
const readyUrls = new Set<string>();

/**
 * Injects a Google Fonts stylesheet and waits until the font is actually
 * available (document.fonts.load resolves). Caches CSS + binaries in the
 * background via the Cache API for offline / PWA use.
 *
 * Returns immediately if the font is already ready.
 */
async function loadGoogleFont(url: string, familyName: string): Promise<void> {
	if (readyUrls.has(url)) return;

	if (!injectedUrls.has(url)) {
		injectedUrls.add(url);
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = url;
		link.crossOrigin = 'anonymous';
		document.head.appendChild(link);
	}

	// Block until the font is actually usable by the browser.
	// Race against a 4s timeout — document.fonts.load() can hang on slow mobile connections.
	await Promise.race([
		document.fonts.load(`400 16px "${familyName}"`),
		new Promise<void>(resolve => setTimeout(resolve, 4000)),
	]);
	readyUrls.add(url);

	// Cache CSS + binary font files in the background (don't block the caller)
	if (typeof caches !== 'undefined') {
		caches.open('reading-fonts-v1').then(async (cache) => {
			const existing = await cache.match(url);
			if (existing) return;
			const cssResp  = await fetch(url);
			const cssText  = await cssResp.text();
			await cache.put(url, new Response(cssText, { headers: { 'Content-Type': 'text/css' } }));
			const fontUrls = [...cssText.matchAll(/url\(([^)'"]+)/g)].map(m => m[1]);
			await Promise.allSettled(fontUrls.map(async (fu) => {
				const hit = await cache.match(fu);
				if (!hit) await cache.put(fu, await fetch(fu));
			}));
		}).catch(() => { /* quota / network error — non-fatal */ });
	}
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
	drawerOpen: boolean;
	isLoggedIn: boolean;
	emailOn: boolean;
	onEmailToggle: () => void;
}

export default function CustomizationPanel({ drawerOpen, isLoggedIn, emailOn, onEmailToggle }: Props) {
	const [open, setOpen]             = useState(false);
	const [prefs, setPrefs]           = useState<Prefs>(DEFAULTS);
	const [ready, setReady]           = useState(false);
	const [loadingFontId, setLoadingFontId] = useState<string | null>(null);

	// Bootstrap from localStorage: load the saved (or default) font before showing the FAB
	useEffect(() => {
		const p = loadPrefs();
		setPrefs(p);
		const font = FONTS.find(f => f.id === p.fontId) ?? FONTS[0];
		const init = async () => {
			// Inter is already in the <head> stylesheet so this resolves immediately on cache hit
			if (font.googleUrl && font.familyName) {
				try { await loadGoogleFont(font.googleUrl, font.familyName); } catch { /* fall through to system fallback */ }
			}
			applyPrefs(p, font);
			setReady(true);
		};
		init();
	}, []);

	// Collapse panel (keep button) when a drawer opens
	useEffect(() => {
		if (drawerOpen) setOpen(false);
	}, [drawerOpen]);

	// Collapse panel on scroll in the main content area
	useEffect(() => {
		if (!ready) return;
		const el = document.getElementById('main-scroll');
		if (!el) return;
		const onScroll = () => setOpen(false);
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, [ready]);

	const update = useCallback((patch: Partial<Prefs>) => {
		setPrefs(prev => {
			const next = { ...prev, ...patch };
			const font = FONTS.find(f => f.id === next.fontId) ?? FONTS[0];
			applyPrefs(next, font);
			savePrefs(next);
			return next;
		});
	}, []);

	// Async font selector: shows a spinner and blocks other clicks while loading
	const handleFontSelect = useCallback(async (font: FontOption) => {
		if (loadingFontId !== null) return; // another font is loading — block

		// No network needed (already bundled or already confirmed ready)
		if (!font.googleUrl || !font.familyName || readyUrls.has(font.googleUrl)) {
			update({ fontId: font.id });
			return;
		}

		setLoadingFontId(font.id);
		try {
			await loadGoogleFont(font.googleUrl, font.familyName);
		} catch { /* network failed — fall through; browser will use CSS fallback */ }
		setLoadingFontId(null);
		update({ fontId: font.id });
	}, [loadingFontId, update]);

	const reset = useCallback(() => {
		if (loadingFontId !== null) return;
		update(DEFAULTS);
	}, [loadingFontId, update]);

	if (!ready) return null;

	const isDark = document.documentElement.classList.contains('dark');

	return (
		<div
			className="fixed right-4 sm:right-6 z-30 flex flex-col items-end gap-2 print:hidden"
			style={{ bottom: 'max(1rem, calc(env(safe-area-inset-bottom, 0px) + 1rem))' }}
		>

			{/* ── Panel ──────────────────────────────────────────────────────── */}
			<div
				className={[
					'transition-all duration-200 origin-bottom-right',
					open
						? 'opacity-100 scale-100 pointer-events-auto'
						: 'opacity-0 scale-95 pointer-events-none',
				].join(' ')}
			>
				<div className="w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">

					{/* Header */}
					<div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
						<p className="text-[10px] font-bold tracking-widest uppercase text-slate-500 dark:text-slate-400">
							Customize
						</p>
						<div className="flex items-center gap-1">
							<button
								onClick={reset}
								className="text-[10px] text-slate-400 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-400 transition-colors px-1.5 py-0.5 rounded flex items-center gap-0.5"
								title="Reset to defaults"
							>
								<IconRotate size={10} />
								Reset
							</button>
							<button
								onClick={() => setOpen(false)}
								className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:text-slate-600 dark:hover:text-slate-300 transition-colors"
								aria-label="Close"
							>
								<IconX size={14} />
							</button>
						</div>
					</div>

					<div className="px-4 py-3 space-y-4 max-h-[70vh] overflow-y-auto">

						{/* ── Font family ──────────────────────────────────── */}
						<section>
							<p className="text-[10px] font-bold tracking-widest uppercase text-slate-400 dark:text-slate-600 mb-2">
								Font
							</p>
							<div className="grid grid-cols-2 gap-1">
								{FONTS.map(font => {
									const active    = prefs.fontId === font.id;
									const isLoading = loadingFontId === font.id;
									const dimmed    = loadingFontId !== null && !isLoading;
									return (
										<button
											key={font.id}
											onClick={() => handleFontSelect(font)}
											disabled={dimmed}
											style={{ fontFamily: font.cssFamily }}
											className={[
												'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-sm leading-none',
												isLoading || active
													? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
													: dimmed
														? 'opacity-30 cursor-not-allowed text-slate-600 dark:text-slate-400'
														: 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors',
											].join(' ')}
										>
											{isLoading ? (
												<>
													<span className="truncate opacity-80">{font.label}</span>
													<IconLoader2 size={12} className="shrink-0 ml-1 animate-spin" />
												</>
											) : (
												<>
													<span className="truncate">{font.label}</span>
													<span className={['text-[9px] shrink-0 ml-1 font-mono', active ? 'opacity-60' : 'opacity-40'].join(' ')}>
														{font.category}
													</span>
												</>
											)}
										</button>
									);
								})}
							</div>
						</section>

						{/* ── Font size ────────────────────────────────────── */}
						<section>
							<p className="text-[10px] font-bold tracking-widest uppercase text-slate-400 dark:text-slate-600 mb-2">
								Size
							</p>
							<div className="flex gap-1">
								{FONT_SIZES.map(sz => (
									<button
										key={sz.id}
										onClick={() => update({ fontSize: sz.id })}
										title={sz.title}
										className={[
											'flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors',
											prefs.fontSize === sz.id
												? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
												: 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400',
										].join(' ')}
									>
										{sz.label}
									</button>
								))}
							</div>
						</section>

						{/* ── Line spacing ─────────────────────────────────── */}
						<section>
							<p className="text-[10px] font-bold tracking-widest uppercase text-slate-400 dark:text-slate-600 mb-2">
								Spacing
							</p>
							<div className="flex gap-1">
								{LINE_HEIGHTS.map(lh => (
									<button
										key={lh.id}
										onClick={() => update({ lineHeight: lh.id })}
										className={[
											'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors',
											prefs.lineHeight === lh.id
												? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
												: 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400',
										].join(' ')}
									>
										{lh.label}
									</button>
								))}
							</div>
						</section>

						{/* ── Reading width ─────────────────────────────────── */}
						<section>
							<p className="text-[10px] font-bold tracking-widest uppercase text-slate-400 dark:text-slate-600 mb-2">
								Width
							</p>
							<div className="flex gap-1">
								{READING_WIDTHS.map(w => (
									<button
										key={w.id}
										onClick={() => update({ readingWidth: w.id })}
										className={[
											'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors',
											prefs.readingWidth === w.id
												? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
												: 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400',
										].join(' ')}
									>
										{w.label}
									</button>
								))}
							</div>
						</section>

						{/* ── Accent color ──────────────────────────────────── */}
						<section>
							<p className="text-[10px] font-bold tracking-widest uppercase text-slate-400 dark:text-slate-600 mb-2">
								Accent
							</p>
							<div className="flex gap-2">
								{ACCENTS.map(a => {
									const active = prefs.accent === a.id;
									const color  = isDark ? a.darkColor : a.color;
									return (
										<button
											key={a.id}
											onClick={() => update({ accent: a.id })}
											title={a.label}
											style={{ backgroundColor: color, outline: active ? `2px solid ${color}` : undefined, outlineOffset: active ? '3px' : undefined }}
											className={[
												'w-7 h-7 rounded-full transition-all duration-150',
												active ? 'scale-110' : 'opacity-60 hover:opacity-90 hover:scale-105',
											].join(' ')}
											aria-label={a.label}
										/>
									);
								})}
							</div>
						</section>

						{/* ── Email toggle (logged-in users only) ───────────── */}
						{isLoggedIn && (
							<section className="pt-1 border-t border-slate-100 dark:border-slate-800">
								<div className="flex items-center justify-between py-0.5">
									<div>
										<p className="text-xs font-medium text-slate-700 dark:text-slate-300">
											Daily email
										</p>
										<p className="text-[10px] text-slate-400 dark:text-slate-600 mt-0.5">
											Receive the morning briefing
										</p>
									</div>
									<button
										onClick={onEmailToggle}
										className={[
											'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none',
											emailOn ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
										].join(' ')}
										aria-label={emailOn ? 'Disable daily email' : 'Enable daily email'}
									>
										<span className={[
											'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
											emailOn ? 'translate-x-4' : 'translate-x-1',
										].join(' ')} />
									</button>
								</div>
							</section>
						)}
					</div>
				</div>
			</div>

			{/* ── FAB ────────────────────────────────────────────────────────── */}
			<button
				onClick={() => setOpen(o => !o)}
				className={[
					'w-11 h-11 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 border',
					open
						? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-transparent shadow-xl'
						: 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:shadow-xl',
				].join(' ')}
				aria-label={open ? 'Close customization' : 'Customize reading experience'}
				title={open ? 'Close' : 'Customize'}
			>
				<IconAdjustments size={18} />
			</button>
		</div>
	);
}
