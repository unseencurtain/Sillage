/**
 * Retail storefront only. Wholesale lives in unseencurtain/sillage-b2b.
 *
 * Dispatch is decided by one thing: the Orders page Dry-run / Live choice, on every stack.
 * A development stack talks to the same two wholesalers with the same credentials as the shop —
 * there is no sandbox anywhere — so pretending it is a safe sandbox would be a lie, and refusing
 * Live there would mean the ordering path could never be exercised before it matters.
 */

/** No-op: retail vendor rows are operator-owned. Kept so migrate/boot still call one function. */
export async function applyStorefrontProfile(): Promise<void> {}
