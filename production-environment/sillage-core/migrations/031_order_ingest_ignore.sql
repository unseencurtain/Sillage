-- Orders the operator deleted from the dashboard.
--
-- Deleting a dispatch row is not enough on its own: `sweepDispatchableOrders` re-imports any live
-- WooCommerce order (wc-processing / wc-completed) that has no row left in `sil_vendor_orders`, so a
-- deleted test order would come back within the hour. A row here is the tombstone that keeps it
-- deleted — `ingestOrder()` skips any order listed here, whichever path called it (webhook or sweep).
--
-- Only orders the operator deleted on purpose land here, and only once every one of their dispatch
-- rows is gone. Nothing removes a row automatically.
CREATE TABLE IF NOT EXISTS sil_order_ingest_ignore (
  wc_order_id BIGINT(20) UNSIGNED NOT NULL,
  reason      VARCHAR(190)     NOT NULL DEFAULT 'deleted in dashboard',
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (wc_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
