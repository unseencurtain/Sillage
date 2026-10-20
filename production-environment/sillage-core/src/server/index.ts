/**
 * The sillage-core HTTP service: webhooks, dashboard API, and the built React UI.
 *
 * Kept as a separate container from the scheduler so a full sync cannot stall an inbound order
 * webhook or the operator dashboard.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { applyStorefrontProfile } from "../storefront/profile.ts";
import { applyRuntimeUrls, env } from "../config/env.ts";
import { loadSecretsOverlay } from "../config/secrets.ts";
import { closePool, query, waitForDatabase } from "../db/pool.ts";
import { loadSettings } from "../db/settings.ts";
import { logger, setLogLevel } from "../lib/log.ts";
import { api } from "./routes/api.ts";
import { auth } from "./routes/auth.ts";
import { forms } from "./routes/forms.ts";
import { reviews } from "./routes/reviews.ts";
import { webhooks } from "./routes/webhooks.ts";
import { reviewsStore } from "../reviews/store.ts";

setLogLevel(env.logLevel);
const log = logger("server");

const secretsBoot = loadSecretsOverlay();
if (secretsBoot.applied > 0) {
  log.info(`applied ${secretsBoot.applied} secret(s) from ${secretsBoot.path}`);
}

// Open the review file at boot: it creates the database (and its bind-mounted directory) before
// the first customer asks for it, so a missing mount or a read-only volume fails in the log at
// deploy time rather than as an empty rating on a product page. Reviews are not the shop's
// checkout path; a failure here must not stop the engine serving the catalogue or orders.
try {
  reviewsStore();
  log.info(`reviews: SQLite ready at ${env.reviewsDb}`);
} catch (err) {
  log.error(`reviews: SQLite unavailable at ${env.reviewsDb}: ${String(err)}`);
}

export const app = new Hono();

app.get("/health", async (c) => {
  try {
    await query("SELECT 1 AS ok");
    return c.json({
      ok: true,
      service: "sillage-core",
      database: "up",
      profile: env.sillageProfile,
    });
  } catch (err) {
    return c.json({ ok: false, service: "sillage-core", database: "down", error: String(err) }, 503);
  }
});

app.route("/api/webhooks", webhooks);
app.route("/api/auth", auth);
// Public storefront forms. Mounted before the session-guarded `/api` so `requireSession` never
// reaches them; see src/server/routes/forms.ts.
app.route("/api/public", forms);
// Product reviews: SQLite-backed, read by the storefront and by the product-page generator.
app.route("/api/public", reviews);
app.route("/api", api);

const distDir = join(env.rootDir, "web/dist");
if (existsSync(distDir)) {
  // Cache policy for the two kinds of file. The bundle carries a content hash, so it can be kept
  // forever; the shell must not be, or a browser that already has it keeps loading the previous
  // bundle after a deploy — which reads as "the fix never shipped" long after it did.
  app.use("/*", async (c, next) => {
    const cache = c.req.path.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    c.header("Cache-Control", cache);
    await next();
    c.res.headers.set("Cache-Control", cache);
  });
  app.use("/*", serveStatic({ root: distDir }));
  app.get("*", async (c) => {
    const file = Bun.file(join(distDir, "index.html"));
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
      });
    }
    return c.json({ ok: false, error: "dashboard not built" }, 404);
  });
} else {
  app.get("/", (c) =>
    c.json({
      ok: true,
      service: "sillage-core",
      message: "API up. Build the dashboard with `bun run web:build` and restart.",
    }),
  );
}

app.notFound((c) => c.json({ ok: false, error: "not found" }, 404));

app.onError((err, c) => {
  log.error(`unhandled error on ${c.req.method} ${c.req.path}`, String(err));
  return c.json({ ok: false, error: "internal error" }, 500);
});

if (import.meta.main) {
  await waitForDatabase();
  try {
    await applyStorefrontProfile();
  } catch (err) {
    log.warn(`storefront profile apply skipped: ${String(err)}`);
  }
  try {
    const settings = await loadSettings();
    applyRuntimeUrls({ wpBaseUrl: settings.wpBaseUrl, imageCdnBaseUrl: settings.imageCdnBaseUrl });
    log.info(`shop URL ${env.wordpress.baseUrl}`);
  } catch (err) {
    log.warn(`could not load settings URLs at boot: ${String(err)}`);
  }
  const server = Bun.serve({ port: env.port, hostname: "0.0.0.0", fetch: app.fetch });
  log.info(`listening on http://0.0.0.0:${server.port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info(`received ${signal}, shutting down`);
      void server.stop(true).then(closePool).then(() => process.exit(0));
    });
  }
}
