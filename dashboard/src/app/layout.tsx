import type { Metadata } from "next";
import { Inter, DM_Serif_Display, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

// Inter — clean, professional sans-serif for all UI and body text
const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
});

// DM Serif Display — authoritative serif for the date heading and article titles only
const dmSerif = DM_Serif_Display({
	variable: "--font-dm-serif",
	subsets: ["latin"],
	weight: "400",
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

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
		url: "https://dashboard.shubhanraj2002.workers.dev",
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
		icon: "/favicon.svg",
		apple: "/favicon.svg",
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
				{/* Inline script — no network round-trip, runs synchronously during HTML parse before first paint */}
				<Script id="theme-init" strategy="beforeInteractive">{`(function(){try{var t=localStorage.getItem('intel-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})();`}</Script>
			</head>
			<body className={`${inter.variable} ${dmSerif.variable} ${geistMono.variable} antialiased`}>
				{children}
			</body>
		</html>
	);
}
