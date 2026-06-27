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
	category: text('category'),
	source: text('source'),
	isPreserved: integer('is_preserved').default(0),
	clusterId: integer('cluster_id'),
	parseType: text('parse_type').default('full'),
	createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const intelClusters = sqliteTable('intel_clusters', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	trackingDate: text('tracking_date').notNull(),
	title: text('title'),
	summary: text('summary'),
	category: text('category'),
	sources: text('sources'),
	createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export const tempArticles = sqliteTable('temp_articles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	trackingDate: text('tracking_date').notNull(),
	title: text('title').notNull(),
	titleEn: text('title_en'),
	fullText: text('full_text'),
	url: text('url').notNull(),
	source: text('source').notNull(),
	isImportant: integer('is_important').default(0),
	importanceReason: text('importance_reason'),
	clusterId: integer('cluster_id'),
	parseType: text('parse_type').default('full'),
	createdAt: text('created_at').default(sql`(datetime('now'))`),
});

export type IntelBriefing = typeof intelBriefings.$inferSelect;
export type NewIntelBriefing = typeof intelBriefings.$inferInsert;
export type IntelArticle = typeof intelArticles.$inferSelect;
export type NewIntelArticle = typeof intelArticles.$inferInsert;
export type IntelCluster = typeof intelClusters.$inferSelect;
export type NewIntelCluster = typeof intelClusters.$inferInsert;
export const settings = sqliteTable('settings', {
	key:   text('key').primaryKey(),
	value: text('value').notNull(),
});

export type TempArticle = typeof tempArticles.$inferSelect;
export type NewTempArticle = typeof tempArticles.$inferInsert;
