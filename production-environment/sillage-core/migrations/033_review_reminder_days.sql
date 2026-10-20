-- Days between the last delivery on an order and its review reminder email.
-- 3 is the product default; the dashboard edits it under Settings → Review reminders.
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('review_reminder_days', '3');
