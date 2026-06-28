'use client';

import { useState, useEffect, useCallback } from 'react';
import {
	IconAdjustments,
	IconX,
	IconRotate,
} from '@tabler/icons-react';

// ── Font catalogue ────────────────────────────────────────────────────────────

interface FontOption {
	id: string;
	label: string;
	category: 'Sans' | 'Serif' | 'Slab' | 'Mono';
	cssFamily: string;
	googleUrl: string | null;
}

const FONTS: FontOption[] = [
	{ id: 'inter',        label: 'Inter',          category: 'Sans',  cssFamily: 'var(--font-inter)',                       googleUrl: null },
	{ id: 'space-grotesk',label: 'Space Grotesk',  category: 'Sans',  cssFamily: "'Space Grotesk', sans-serif",             googleUrl: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap' },
	{ id: 'dm-serif',     label: 'DM Serif',        category: 'Serif', cssFamily: 'var(--font-dm-serif)',                    googleUrl: null },
	{ id: 'lora',         label: 'Lora',            category: 'Serif', cssFamily: "'Lora', Georgia, serif",                  googleUrl: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&display=swap' },
	{ id: 'merriweather', label: 'Merriweather',    category: 'Serif', cssFamily: "'Merriweather', Georgia, serif",          googleUrl: 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap' },
	{ id: 'playfair',     label: 'Playfair',        category: 'Serif', cssFamily: "'Playfair Display', Georgia, serif",      googleUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap' },
	{ id: 'crimson',      label: 'Crimson',         category: 'Serif', cssFamily: "'Crimson Text', Georgia, serif",          googleUrl: 'https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600&display=swap' },
	{ id: 'bitter',       label: 'Bitter',          category: 'Slab',  cssFamily: "'Bitter', Georgia, serif",                googleUrl: 'https://fonts.googleapis.com/css2?family=Bitter:wght@400;700&display=swap' },
	{ id: 'geist-mono',   label: 'Geist Mono',      category: 'Mono',  cssFamily: 'var(--font-geist-mono)',                  googleUrl: null },
	{ id: 'jetbrains',    label: 'JetBrains',       category: 'Mono',  cssFamily: "'JetBrains Mono', monospace",             googleUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap' },
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

const loadedFontUrls = new Set<string>();

async function loadGoogleFont(url: string): Promise<void> {
	if (loadedFontUrls.has(url)) return;
	loadedFontUrls.add(url);

	// Inject stylesheet link
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = url;
	link.crossOrigin = 'anonymous';
	document.head.appendChild(link);

	// Pre-cache the font CSS + binary files for offline / PWA use
	if (typeof caches === 'undefined') return;
	try {
		const cache = await caches.open('reading-fonts-v1');
		const existing = await cache.match(url);
		if (existing) return;

		const cssResp = await fetch(url);
		const cssText = await cssResp.text();
		await cache.put(url, new Response(cssText, { headers: { 'Content-Type': 'text/css' } }));

		// Parse and cache individual .woff2 / .woff files
		const fontUrls = [...cssText.matchAll(/url\(([^)'"]+)/g)].map(m => m[1]);
		await Promise.allSettled(fontUrls.map(async (fontUrl) => {
			const hit = await cache.match(fontUrl);
			if (!hit) {
				const fontResp = await fetch(fontUrl);
				await cache.put(fontUrl, fontResp);
			}
		}));
	} catch { /* caches API unavailable or quota exceeded */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
	drawerOpen: boolean;
	isLoggedIn: boolean;
	emailOn: boolean;
	onEmailToggle: () => void;
}

export default function CustomizationPanel({ drawerOpen, isLoggedIn, emailOn, onEmailToggle }: Props) {
	const [open, setOpen]   = useState(false);
	const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
	const [ready, setReady] = useState(false);

	// Bootstrap from localStorage, apply immediately
	useEffect(() => {
		const p = loadPrefs();
		setPrefs(p);
		const font = FONTS.find(f => f.id === p.fontId) ?? FONTS[0];
		applyPrefs(p, font);
		if (font.googleUrl) loadGoogleFont(font.googleUrl);
		setReady(true);
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
			if (font.googleUrl) loadGoogleFont(font.googleUrl);
			savePrefs(next);
			return next;
		});
	}, []);

	const reset = useCallback(() => update(DEFAULTS), [update]);

	if (!ready) return null;

	const isDark = document.documentElement.classList.contains('dark');

	return (
		<div className="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2 print:hidden">

			{/* ── Panel ──────────────────────────────────────────────────────── */}
			<div
				className={[
					'transition-all duration-200 origin-bottom-right',
					open
						? 'opacity-100 scale-100 pointer-events-auto'
						: 'opacity-0 scale-95 pointer-events-none',
				].join(' ')}
			>
				<div className="w-72 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">

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
									const active = prefs.fontId === font.id;
									return (
										<button
											key={font.id}
											onClick={() => update({ fontId: font.id })}
											style={{ fontFamily: font.cssFamily }}
											className={[
												'flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors text-sm leading-none',
												active
													? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
													: 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300',
											].join(' ')}
										>
											<span className="truncate">{font.label}</span>
											<span className={['text-[9px] shrink-0 ml-1 font-mono', active ? 'opacity-60' : 'opacity-40'].join(' ')}>
												{font.category}
											</span>
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
