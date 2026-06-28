import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
	title: {
		default: "Chinese Intel Monitor",
		template: "%s · Chinese Intel Monitor",
	},
	description:
		"Daily intelligence briefings extracted from seven Chinese provincial newspapers, analysed by AI and translated into English.",
	keywords: ["China", "intelligence", "provincial press", "briefing", "Xinhua", "geopolitics"],
	authors: [{ name: "Chinese Intel Pipeline" }],
	openGraph: {
		type: "website",
		locale: "en_US",
		url: "https://intel-pipeline.shubhanraj2002.workers.dev",
		siteName: "Chinese Intel Monitor",
		title: "Chinese Intel Monitor",
		description:
			"Daily AI-powered intelligence briefings from seven Chinese provincial newspapers.",
	},
	twitter: {
		card: "summary",
		title: "Chinese Intel Monitor",
		description:
			"Daily AI-powered intelligence briefings from seven Chinese provincial newspapers.",
	},
	icons: {
		// SVG for Chrome/Firefox; PNG fallback for Safari (no SVG favicon support)
		icon: [
			{ url: "/favicon.svg", type: "image/svg+xml" },
			{ url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
		],
		apple: "/apple-touch-icon.png",
	},
	manifest: "/manifest.json",
	appleWebApp: {
		capable: true,
		statusBarStyle: "default",
		title: "Intel Monitor",
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<head>
				{/* Pre-connect to Google Fonts to reduce latency */}
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
				{/* Inter — default reading font; loaded eagerly so it's ready before JS hydrates */}
				<link
					rel="stylesheet"
					href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
				/>
				{/* Inline script — runs synchronously before first paint: applies dark mode + reading prefs */}
				<Script id="theme-init" strategy="beforeInteractive">{`(function(){try{var t=localStorage.getItem('intel-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark');var p=JSON.parse(localStorage.getItem('intel-reading-prefs-v1')||'{}');var r=document.documentElement;if(p.fontSize&&p.fontSize!=='base')r.setAttribute('data-rs',p.fontSize);if(p.lineHeight&&p.lineHeight!=='comfortable')r.setAttribute('data-rlh',p.lineHeight);if(p.readingWidth&&p.readingWidth!=='medium')r.setAttribute('data-rw',p.readingWidth);if(p.accent&&p.accent!=='red')r.setAttribute('data-accent',p.accent)}catch(e){}})();`}</Script>
			</head>
			<body className="antialiased">
				{children}
			</body>
		</html>
	);
}
