-- The mailbox the engine sends storefront form notifications with (src/lib/mail.ts).
--
-- Purelymail is the shop's provider, so the transport is fixed: smtp.purelymail.com on port 465 over
-- implicit TLS. These two settings — the mailbox and its password — are the whole of the mail
-- configuration, and they are edited like any other setting on Settings → Email sending. Empty means
-- the forms still store every message in the dashboard's Messages tab, they are simply not emailed.
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('mail_username', 'hello@prinscosmetic.eu'),
  ('mail_password', '');
