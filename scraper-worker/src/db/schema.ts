import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const intelBriefings = sqliteTable('intel_briefings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	trackingDate: text('tracking_date').unique().notNull(),
	rawScrapedText: text('raw_scraped_text'),
	aiAnalysisMarkdown: text('ai_analysis_markdown'),
	emailStatus: integer('email_status').default(0),
});

export const intelArticles = sqliteTable('intel_articles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	trackingDate: text('tracking_date').notNull().references(() => intelBriefings.trackingDate),
	title: text('title'),
	summary: text('summary'),
	fullText: text('full_text'),
	fullTextEn: text('full_text_en'),
	url: text('url'),
	isPreserved: integer('is_preserved').default(0),
	createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export type IntelBriefing = typeof intelBriefings.$inferSelect;
export type NewIntelBriefing = typeof intelBriefings.$inferInsert;
export type IntelArticle = typeof intelArticles.$inferSelect;
export type NewIntelArticle = typeof intelArticles.$inferInsert;
