/**
 * Retail storefront only. Wholesale lives in unseencurtain/sillage-b2b.
 *
 * `resolveDispatchDryRun` honours the dashboard's Dry-run / Live choice, except on the
 * development box, where Live is refused outright.
 */
import { env } from "../config/env.ts";

/**
 * Whether a dispatch is a rehearsal, given what was asked and which machine is asking.
 *
 * Neither wholesaler offers a sandbox, so "Live" on a dev box would place a real order against
 * real credentials and bill a real card. A dev box can only ever rehearse: the operator's request
 * is read, then overruled.
 */
export function dispatchDryRun(requested: boolean, devBox: boolean): boolean {
  return devBox ? true : requested;
}

/** Same decision, reading this deployment's own `SILLAGE_DEV_BOX`. */
export function resolveDispatchDryRun(requested: boolean): boolean {
  return dispatchDryRun(requested, env.devBox);
}

/** No-op: retail vendor rows are operator-owned. Kept so migrate/boot still call one function. */
export async function applyStorefrontProfile(): Promise<void> {}
