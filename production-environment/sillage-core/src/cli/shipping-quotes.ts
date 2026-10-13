/**
 * Refresh the vendor shipping quote cache when it is due. Run from the cron tick; it does nothing
 * until shipping_quote_refresh_hours has passed since the last refresh.
 *
 *   bun run src/cli/shipping-quotes.ts              # refresh if due
 *   bun run src/cli/shipping-quotes.ts -- --force   # refresh now
 */
import { env } from "../config/env.ts";
import { closePool, waitForDatabase } from "../db/pool.ts";
import { logger, setLogLevel } from "../lib/log.ts";
import { refreshAllQuotes, refreshDue } from "../shipping/quotes.ts";

setLogLevel(env.logLevel);
const log = logger("cli");
const force = process.argv.includes("--force");

try {
  await waitForDatabase();
  if (!force && !(await refreshDue())) process.exit(0);
  const results = await refreshAllQuotes();
  console.log(JSON.stringify(results, null, 2));
  log.info("shipping quotes refreshed", JSON.stringify(results));
} catch (err) {
  log.error("shipping quote refresh failed", String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closePool();
}
