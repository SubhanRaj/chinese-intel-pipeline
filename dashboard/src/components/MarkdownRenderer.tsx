'use client';

import ReactMarkdown from 'react-markdown';

interface Props {
	content: string;
}

export default function MarkdownRenderer({ content }: Props) {
	return <ReactMarkdown>{content}</ReactMarkdown>;
}
