# SEO / Googlebot — retail shop

How Google sees `prinscosmetic.eu`, what we block on purpose, and the sitemap bug we patch.

## Verdict (live checks, 2026-09-03)

| Check | Result |
|---|---|
| Googlebot → `/` and `/product/…` | **HTTP 200** (not blocked) |
| Caddy `@heavybot` vs Googlebot | **Does not match** — only ClaudeBot / GPTBot / CCBot / Bytespider / Amazonbot / meta-externalagent |
| `robots.txt` | SEO-safe; points at `wp-sitemap.xml`; does **not** Disallow products |
| Product `noindex` (shop-visible) | **No** — only `max-image-preview:large` |
| Canonical on product pages | Correct absolute `https://prinscosmetic.eu/product/…/` |
| Auth / redirects for Googlebot | None on product URLs |
| Product JSON-LD | **Missing** (theme/Woo default may omit) — ranking quality gap, not a crawl block |
| Full-page cache | **None** — Valkey is object cache only; Googlebot still runs full Apache/PHP/Woo (~0.9s TTFB) |

## Critical bug we fix in the bridge

Core WordPress sitemap pagination ([Trac #51912](https://core.trac.wordpress.org/ticket/51912) / #65375):

- Index lists `wp-sitemap-posts-product-1.xml` … `product-28.xml` (~54 509 products at 2000/page).
- Page **1** returns **200**.
- Pages **2–28** return **HTTP 404** with a **valid XML body**.
- Google Search Console / Googlebot **ignore 404 sitemaps**, so only ~2000 products were reliably discoverable via sitemap.

**Fix:** `Sillage_Seo` in the bridge (`pre_handle_404` + clear 404 on sitemap `template_redirect`). After deploy, every `wp-sitemap-posts-product-N.xml` must return **200**.

Also:

- Drop the **users** sitemap (`/author/sugar/`).
- Send **`noindex, nofollow`** on catalogue-hidden products (`! $product->is_visible()` — no image / stock / operator pin). They stay Published for sync but should not rank.

## What Google can index vs what the shop shows

| State | Shop loop | Google |
|---|---|---|
| In stock + usable photo | Visible | Indexable |
| Hidden · no image / stock / pinned | Hidden from `/shop` | **noindex** after bridge 1.1.0 |
| Direct `/product/slug/` URL | Still HTTP 200 | Crawlable; hidden ones noindex |

Hide-without-image stays **on**. Do not unhide the catalogue to “help SEO”.

## Caddy vs Google

```caddy
@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
```

`Googlebot`, `Googlebot-Image`, and `Google-Extended` are **not** in that list. Do not add them.

AI training crawlers stay 403 so the 4 GB prefork box does not melt ([`CRAWLER-SHIELD.md`](CRAWLER-SHIELD.md)).

## After deploy — operator checklist

```bash
# must be 200 (was 404)
curl -sI -A 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' \
  https://prinscosmetic.eu/wp-sitemap-posts-product-2.xml | head -5

# still 200
curl -sI -A 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' \
  https://prinscosmetic.eu/product/SOME-VISIBLE-SLUG/ | head -5

# ClaudeBot still blocked
curl -sI -A 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' https://prinscosmetic.eu/ | head -5
```

In Google Search Console: resubmit `https://prinscosmetic.eu/wp-sitemap.xml`.

## Deploy note

Bridge files are rsynced by `deploy-vps.sh` into `wp-content/plugins/sillage-bridge/`. No Hub image rebuild required for this PHP-only change — copy the plugin onto the VPS and flush caches if needed (`docker exec ecom` object-cache / reopen sitemap URL).
