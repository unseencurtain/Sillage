import { BeautyfortConnector } from "./beautyfort/connector.ts";
import { BtsConnector } from "./bts/connector.ts";
import { WholesalePerfumesConnector } from "./wholesale-perfumes/connector.ts";
import type { VendorConnector } from "./VendorConnector.ts";

/**
 * Vendors parked for a separate B2B website (see repo `b2b-wholesale/`).
 * Still registered for explicit `--vendor=<slug>` / tests, but never selected by `--vendor=all`
 * on this retail storefront — even if someone flips `sil_vendors.active` by mistake.
 */
export const PARKED_B2B_VENDOR_SLUGS = new Set(["wholesale-perfumes"]);

export function isParkedB2bVendor(slug: string): boolean {
  return PARKED_B2B_VENDOR_SLUGS.has(slug);
}

/**
 * Adding a vendor: implement VendorConnector, add it here, add a row to sil_vendors. No PHP
 * changes and no schema changes.
 *
 * wholesale-perfumes stays registered (history + future B2B site) but is parked for main sync.
 */
export function createConnectors(): VendorConnector[] {
  return [new BeautyfortConnector(), new BtsConnector(), new WholesalePerfumesConnector()];
}

export function createConnector(slug: string): VendorConnector {
  const found = createConnectors().find((c) => c.slug === slug);
  if (!found) throw new Error(`Unknown vendor "${slug}"`);
  return found;
}
