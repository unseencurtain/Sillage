-- Ocean (wholesale-perfumes.eu): vendor seed, VAT column, live-feed caps.
-- Catalog ≤1 download/day; store (price/stock) may run hourly.

-- Ex-VAT prices need a vendor-level VAT uplift before markup tiers. Default 0 leaves
-- BeautyFort and BTS numbers unchanged.
ALTER TABLE sil_vendors
  ADD COLUMN vat_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0000
    COMMENT 'Fraction added to vendor_price before markup: cost = price × fx × (1+vat_rate)'
    AFTER fx_rate;

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  -- Catalog XML regenerates ~05:00; hard cap one live download per day.
  ('ocean_live_max_per_day', '1'),
  -- Store XML is hourly; allow up to one live pull per hour through the day.
  ('ocean_store_live_max_per_day', '24'),
  ('ocean_store_live_min_minutes', '60');

-- OPERATOR-CONFIRMABLE guesses below (min_order_value_eur, serviceable_countries, vat_rate).
-- Seed inactive so nothing syncs until an operator turns the vendor on deliberately.
INSERT IGNORE INTO sil_vendors
  (slug, name, storefront_label, sku_prefix, currency, fx_rate, vat_rate,
   serviceable_countries, order_config, active)
VALUES
  (
    'ocean',
    'Ocean (wholesale-perfumes.eu)',
    'LPS03',
    'OC',
    'EUR',
    1.0,
    -- GUESS: leave 0 until the operator confirms the correct VAT fraction for price_no_vat.
    0.0000,
    -- GUESS: conservative central/western EU set. Confirm against Ocean account / shipping table.
    '["AT","BE","CZ","DE","DK","ES","FI","FR","HU","IE","IT","LU","NL","PL","PT","SE","SK"]',
    -- GUESS: min_order_value_eur=100 — client confirmed a MOQ exists but not the amount.
    '{"min_order_value_eur":100}',
    0
  );
