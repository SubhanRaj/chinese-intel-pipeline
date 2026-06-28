import type { NextConfig } from "next";

// ── Security headers ──────────────────────────────────────────────────────────
// Applied to every response from the dashboard worker.
//
// Adding a new custom domain to this worker:
//   1. Add the domain to wrangler.jsonc `routes` (or CF dashboard).
//   2. Add it to ALLOWED_HOSTS in src/app/login/actions.ts so magic-link
//      URLs are built correctly for that domain too.
//   3. If the new domain serves additional external resources (fonts, CDN,
//      analytics), extend the relevant CSP directives below and redeploy.
//
// CSP note: `unsafe-inline` on script-src is required for the theme-init
// <Script strategy="beforeInteractive"> in layout.tsx (reads/writes
// localStorage only — no external data). If that script is ever moved to a
// standalone .js file, switch to a nonce-based CSP and drop unsafe-inline.

const SECURITY_HEADERS = [
	// Block the dashboard from being embedded in any <iframe> (clickjacking).
	{ key: 'X-Frame-Options', value: 'DENY' },
	// Prevent MIME-type sniffing on served assets.
	{ key: 'X-Content-Type-Options', value: 'nosniff' },
	// Send origin only (no path/query) in Referer — keeps magic-link tokens
	// out of third-party server logs when navigating away from /auth/verify.
	{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
	// Enforce HTTPS for 2 years across all subdomains.
	// Remove `preload` if you ever need to opt a subdomain out of HSTS preloading.
	{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
	// Disable browser features this app never uses.
	{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
	// Content Security Policy.
	{
		key: 'Content-Security-Policy',
		value: [
			"default-src 'self'",
			// unsafe-inline required for the theme-init beforeInteractive script in layout.tsx
			"script-src 'self' 'unsafe-inline'",
			// unsafe-inline required for Tailwind's runtime style injection
			"style-src 'self' 'unsafe-inline'",
			// data: for inline SVG favicons; no external image sources needed
			"img-src 'self' data:",
			// Next.js self-hosts Google Fonts at build time — served from 'self'
			"font-src 'self'",
			// Server actions POST to same origin; no external API calls from the browser
			"connect-src 'self'",
			// Belt-and-suspenders alongside X-Frame-Options
			"frame-ancestors 'none'",
			// Block <object>, <embed>, <applet>
			"object-src 'none'",
			// Restrict <base> to same origin
			"base-uri 'self'",
		].join('; '),
	},
];

const nextConfig: NextConfig = {
	async headers() {
		return [
			{
				source: '/(.*)',
				headers: SECURITY_HEADERS,
			},
		];
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
