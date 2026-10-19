-- Retire the product-name phrase dictionary.
--
-- `025_translations.sql` created `sil_phrases` so a product name could be rewritten word by word
-- ("gift set", "nail polish") without storing a row per product. The owner has since scoped
-- translation to the shop's fixed structure only: a product's own name and description are
-- inventory, already the words the shop typed, and are never translated. Nothing reads the table
-- any more — the `sillage-translations` plugin rewrites category names only — so it goes.
--
-- `sil_translations` is untouched: it still holds the thirteen department names.
DROP TABLE IF EXISTS sil_phrases;
