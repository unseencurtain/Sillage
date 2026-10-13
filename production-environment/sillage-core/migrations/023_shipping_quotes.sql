-- Shipping: vendor quote cache plus operator rules.
--
-- sil_shipping_quotes holds the last vendor cost per (vendor, destination country). A scheduled job
-- refreshes it (see src/shipping/quotes.ts). The WordPress bridge reads this table, so checkout
-- never calls a vendor.
--
-- Rules are global and deliberately simple: one markup applied to every country, and one free-
-- shipping threshold for the whole bag. Defaults change nothing: markup 0, threshold off.

CREATE TABLE IF NOT EXISTS sil_shipping_quotes (
  vendor_slug   VARCHAR(32)   NOT NULL,
  country       CHAR(2)       NOT NULL,
  cost_eur      DECIMAL(10,2) NOT NULL,
  -- Carrier or service name the vendor reported (BTS quotes vary by carrier). Admin only.
  carrier       VARCHAR(100)  NULL,
  -- Business days, when the vendor reports them.
  delivery_days INT           NULL,
  -- ok = fresh quote; error = last refresh failed (kept so the dashboard can show it).
  status        VARCHAR(16)   NOT NULL DEFAULT 'ok',
  quoted_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (vendor_slug, country)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  -- Percent added on top of vendor cost. 0 = pass-through.
  ('shipping_markup_percent', '0'),
  -- Euro added per order on top of vendor cost. 0 = none.
  ('shipping_markup_fixed_eur', '0'),
  -- Whole-bag subtotal (EUR) at or above which shipping is free. 0 = off.
  ('shipping_free_over_eur', '0'),
  -- total = one shipping line; per_location = one line per location.
  ('shipping_display_mode', 'total'),
  -- How often the vendor quote cache refreshes, in hours.
  ('shipping_quote_refresh_hours', '6');
