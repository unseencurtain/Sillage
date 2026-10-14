-- New boxes must not start scheduled vendor calls before the owner configures the store.
-- Existing boxes that already applied 006 keep their current settings because this migration
-- changes only the two schedule gates; orders remain governed by their separate dry-run settings.
UPDATE sil_settings
SET setting_value = '0'
WHERE setting_key IN ('sync_enabled', 'full_sync_enabled');
