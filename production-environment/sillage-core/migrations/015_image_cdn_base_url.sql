-- Public origin for self-hosted product images (the `lps-media` JPEGs).
--
-- `image_overrides.json` stores self-hosted photos as bare filenames, so this is the value that
-- turns `9424115.jpg` into a URL a browser can fetch. Changing it does not rewrite product rows
-- that were already written — repoint with `scripts/repoint-image-cdn.sh`, or sync --rewrite-all.
--
-- Seeded empty on purpose, and it used to be seeded with a hostname. Every database created from
-- these migrations therefore started life pointing at one particular VPS's CDN, whether or not that
-- box had anything to do with the shop being built; both production databases were still carrying
-- that inherited default months after the host was retired. A blank value fails visibly (relative
-- overrides stay relative, are rejected as unusable, and the products show up under "no photo")
-- instead of quietly serving broken images from someone else's machine.
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('image_cdn_base_url', '');
