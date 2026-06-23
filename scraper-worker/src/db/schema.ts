import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const intelBriefings = sqliteTable('intel_briefings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	trackingDate: text('tracking_date').unique().notNull(),
	rawScrapedText: text('raw_scraped_text'),
	aiAnalysisMarkdown: text('ai_analysis_markdown'),
	emailStatus: integer('email_status').default(0),
});

export type IntelBriefing = typeof intelBriefings.$inferSelect;
export type NewIntelBriefing = typeof intelBriefings.$inferInsert;
