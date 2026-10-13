/**
 * Store identity from the command line. Used by adopt-box.sh and deploy, so a copied database
 * gets this box's name and addresses instead of the ones it was taken from.
 *
 *   bun run src/cli/identity.ts show
 *   bun run src/cli/identity.ts set store_name=PrinsCosmetic sender_email=hello@example.com
 *   bun run src/cli/identity.ts push     write the record into WordPress
 *   bun run src/cli/identity.ts check    exit 1 if WordPress differs from the record
 */
import { loadSecretsOverlay } from "../config/secrets.ts";
import { closePool } from "../db/pool.ts";
import { checkIdentity, IDENTITY_KEYS, loadIdentity, pushIdentity, saveIdentity, type IdentityField } from "../identity/identity.ts";
import { setLogLevel } from "../lib/log.ts";

setLogLevel("warn");
loadSecretsOverlay();

async function main(): Promise<number> {
  const [cmd = "show", ...rest] = process.argv.slice(2);

  if (cmd === "show") {
    const identity = await loadIdentity();
    for (const field of Object.keys(IDENTITY_KEYS) as IdentityField[]) {
      console.log(`${field.padEnd(14)} ${identity[field] || "(not set)"}`);
    }
    return 0;
  }

  if (cmd === "set") {
    const patch: Partial<Record<IdentityField, string>> = {};
    for (const pair of rest) {
      const eq = pair.indexOf("=");
      const field = (eq > 0 ? pair.slice(0, eq) : "") as IdentityField;
      if (!(field in IDENTITY_KEYS)) {
        console.error(`unknown field "${pair}". Fields: ${Object.keys(IDENTITY_KEYS).join(", ")}`);
        return 2;
      }
      patch[field] = pair.slice(eq + 1);
    }
    await saveIdentity(patch);
    console.log(`saved ${Object.keys(patch).join(", ")}`);
    return 0;
  }

  if (cmd === "push") {
    const result = await pushIdentity(await loadIdentity());
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (cmd === "check") {
    const { mismatches, retired } = await checkIdentity();
    for (const r of retired) console.log(`RETIRED  record field ${r} still holds a previous store's address`);
    for (const m of mismatches) {
      console.log(`DIFFERS  ${m.field}: WordPress has "${m.wordpress}", record says "${m.record}"`);
    }
    if (mismatches.length === 0 && retired.length === 0) {
      console.log("identity: WordPress matches the record");
      return 0;
    }
    return 1;
  }

  console.error(`unknown command "${cmd}". Use show, set, push or check.`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => closePool());
