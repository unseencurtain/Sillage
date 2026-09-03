#!/usr/bin/env bun
/** Write static product sitemaps. Does not call vendors. Does not touch PHP. */
import { loadSecretsOverlay } from "../src/config/secrets.ts";
import { applyRuntimeUrls } from "../src/config/env.ts";
import { closePool } from "../src/db/pool.ts";
import { loadSettings } from "../src/db/settings.ts";
import { writeProductSitemaps } from "../src/sync/sitemaps.ts";

loadSecretsOverlay();
const settings = await loadSettings();
applyRuntimeUrls({ wpBaseUrl: settings.wpBaseUrl, imageCdnBaseUrl: settings.imageCdnBaseUrl });
const result = await writeProductSitemaps();
console.log(JSON.stringify(result, null, 2));
await closePool();
