import type { Metadata } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

const playfair = Playfair_Display({
	variable: "--font-playfair",
	subsets: ["latin"],
	weight: ["400", "600", "700"],
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
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<body className={`${geistSans.variable} ${geistMono.variable} ${playfair.variable} antialiased`}>
				{children}
			</body>
		</html>
	);
}
