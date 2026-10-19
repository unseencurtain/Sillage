-- Content translation for the headless storefront.
--
-- The React storefront asks every read for `lang=<code>` (English sends nothing). WordPress has no
-- multilingual layer, so the engine owns one: these two tables are the only place a translation
-- lives, and `sillage-translations` reads them to rewrite REST responses on the way out.
--
-- `sil_translations` holds whole-field translations for one entity — a category name, later a page
-- title. `sil_phrases` is a dictionary of the recurring phrases inside a product name ("gift set",
-- "refill", "nail polish") and is applied to the name as the response is built, so 36,000 product
-- names cost a few hundred rows here instead of 830,000, and a brand name is never touched.
--
-- Both are written only by the operator's importer (`bun run translations`); nothing a shopper does
-- reaches them. English is never stored: it is the shop's own language, and a missing row falls
-- back to the name WordPress already has.
CREATE TABLE IF NOT EXISTS sil_translations (
  lang        VARCHAR(8)      NOT NULL,
  entity_type VARCHAR(16)     NOT NULL, -- 'term' (wp_term_id) | 'post' (wp_post_id)
  entity_id   BIGINT UNSIGNED NOT NULL,
  field       VARCHAR(24)     NOT NULL, -- 'name' | 'description' | 'title' | 'excerpt'
  value       TEXT            NOT NULL,
  source      VARCHAR(12)     NOT NULL DEFAULT 'curated', -- 'curated' | 'machine' | 'human'
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (lang, entity_type, entity_id, field),
  KEY lang_type (lang, entity_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_phrases (
  lang        VARCHAR(8)   NOT NULL,
  phrase      VARCHAR(190) NOT NULL, -- the phrase as the feed writes it, lower-cased
  translation VARCHAR(190) NOT NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (lang, phrase)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
