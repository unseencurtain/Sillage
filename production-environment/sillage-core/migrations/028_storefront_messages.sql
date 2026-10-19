-- Storefront messages: the Contact form and the Right-of-Withdrawal form.
--
-- Two public forms, two tables. They share a spine — who wrote, how to reach them, whether they had
-- an account, when it arrived and where it sits in the inbox (new / read / archived) — but a contact
-- message carries a subject and a free-text body, while a withdrawal carries the goods, the dates
-- and the postal address. Keeping them apart means neither table has columns that are permanently
-- empty for half its rows, and each dashboard tab reads one table rather than filtering a mixture.
--
-- WordPress never writes here. The engine owns these tables, the dashboard reads them, and the
-- notification email is sent from the engine — see src/server/routes/forms.ts.

CREATE TABLE IF NOT EXISTS sil_contact_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- new = unread. The operator moves a row to read and may then archive it.
  status      ENUM('new','read','archived') NOT NULL DEFAULT 'new',
  name        VARCHAR(191) NOT NULL DEFAULT '',
  email       VARCHAR(191) NOT NULL,
  phone       VARCHAR(64)  NOT NULL DEFAULT '',
  -- An order number the shopper gave us. Empty is normal on a contact message.
  order_ref   VARCHAR(64)  NOT NULL DEFAULT '',
  subject     VARCHAR(255) NOT NULL DEFAULT '',
  body        MEDIUMTEXT   NULL,
  -- The language the form was sent in, so a reply can open in it.
  locale      VARCHAR(8)   NOT NULL DEFAULT '',
  -- 1 when the submitter held a customer session the moment they sent it, with the customer id
  -- WordPress reported. Verified against WordPress through the request's own session cookie, never
  -- taken from the browser. A guest is 0 / NULL.
  signed_in   TINYINT(1)   NOT NULL DEFAULT 0,
  customer_id BIGINT UNSIGNED NULL,
  ip          VARCHAR(45)  NOT NULL DEFAULT '',
  user_agent  VARCHAR(255) NOT NULL DEFAULT '',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at     DATETIME     NULL DEFAULT NULL,
  archived_at DATETIME     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  -- The tab badge and the list both read by status, newest first.
  KEY status_created (status, created_at),
  -- Rate limiting counts one client's rows inside a window.
  KEY ip_created (ip, created_at),
  KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sil_withdrawal_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  status      ENUM('new','read','archived') NOT NULL DEFAULT 'new',
  name        VARCHAR(191) NOT NULL DEFAULT '',
  email       VARCHAR(191) NOT NULL,
  order_ref   VARCHAR(64)  NOT NULL DEFAULT '',
  -- The goods or services the contract is being withdrawn from.
  goods       TEXT         NULL,
  ordered_on  VARCHAR(20)  NOT NULL DEFAULT '',
  received_on VARCHAR(20)  NOT NULL DEFAULT '',
  -- The consumer's postal address, kept as one free block.
  address     TEXT         NULL,
  comment     TEXT         NULL,
  locale      VARCHAR(8)   NOT NULL DEFAULT '',
  signed_in   TINYINT(1)   NOT NULL DEFAULT 0,
  customer_id BIGINT UNSIGNED NULL,
  ip          VARCHAR(45)  NOT NULL DEFAULT '',
  user_agent  VARCHAR(255) NOT NULL DEFAULT '',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at     DATETIME     NULL DEFAULT NULL,
  archived_at DATETIME     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY status_created (status, created_at),
  KEY ip_created (ip, created_at),
  KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who is notified. Comma-separated, one address or many. Empty falls back to the shop identity's
-- support address and then its admin address, so a fresh install still reaches somebody.
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('contact_recipients', '');
