'use client';

import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';

interface Props {
	content: string;
}

const components: Components = {
	a: ({ href, children }) => {
		const safe = href && (href.startsWith('https://') || href.startsWith('http://'));
		return safe
			? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
			: <span>{children}</span>;
	},
};

export default function MarkdownRenderer({ content }: Props) {
	return (
		<ReactMarkdown rehypePlugins={[rehypeSanitize]} components={components}>
			{content}
		</ReactMarkdown>
	);
}
