-- Add parse_type to distinguish full scraped articles from RSS-only (title + excerpt) articles.
-- Values: 'full' (default) = complete body text was parsed; 'rss' = only RSS title + description available.
ALTER TABLE temp_articles  ADD COLUMN parse_type TEXT NOT NULL DEFAULT 'full';
ALTER TABLE intel_articles ADD COLUMN parse_type TEXT NOT NULL DEFAULT 'full';
