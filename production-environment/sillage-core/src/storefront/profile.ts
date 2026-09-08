/**
 * Retail storefront only. Wholesale lives in unseencurtain/sillage-b2b.
 *
 * `resolveDispatchDryRun` honours the requested flag (dashboard Dry-run / Live).
 * There is no sandbox lock in this repo.
 */
export function resolveDispatchDryRun(requested: boolean): boolean {
  return requested;
}

/** No-op: retail vendor rows are operator-owned. Kept so migrate/boot still call one function. */
export async function applyStorefrontProfile(): Promise<void> {}
