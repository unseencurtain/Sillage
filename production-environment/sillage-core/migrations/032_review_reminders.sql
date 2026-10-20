-- Review reminder emails.
--
-- One row per WooCommerce order. A row is written on the first attempt so a relay outage cannot
-- make the scheduler send the same reminder on every tick; `sent_at` is set only after SMTP
-- accepted the message. The order is eligible once every vendor shipment is delivered (or
-- cancelled) and the last delivery was at least the configured number of days ago.

CREATE TABLE IF NOT EXISTS sil_review_reminders (
  wc_order_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  email           VARCHAR(190)    NOT NULL DEFAULT '',
  attempts        INT             NOT NULL DEFAULT 0,
  sent_at         DATETIME        NULL,
  last_attempt_at DATETIME        NULL,
  last_error      TEXT            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pending (sent_at, last_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
