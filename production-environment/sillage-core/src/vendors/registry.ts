import { BeautyfortConnector } from "./beautyfort/connector.ts";
import { BtsConnector } from "./bts/connector.ts";
import type { VendorConnector } from "./VendorConnector.ts";

/** This retail shop syncs BeautyFort + BTS only. */
export const STOREFRONT_VENDOR_SLUGS = ["beautyfort", "bts"] as const;

export function storefrontVendorSlugs(): string[] {
  return [...STOREFRONT_VENDOR_SLUGS];
}

export function isParkedVendor(slug: string): boolean {
  return !STOREFRONT_VENDOR_SLUGS.includes(slug as (typeof STOREFRONT_VENDOR_SLUGS)[number]);
}

/**
 * `--vendor=all` is BeautyFort + BTS. Unknown slugs (including leftover wholesale-perfumes
 * rows in an old database) are never selected.
 */
export function vendorSelectableForSync(slug: string, _explicit: boolean): boolean {
  return STOREFRONT_VENDOR_SLUGS.includes(slug as (typeof STOREFRONT_VENDOR_SLUGS)[number]);
}

/**
 * Adding a vendor: implement VendorConnector, add it here, add a row to sil_vendors. No PHP
 * changes and no schema changes.
 */
export function createConnectors(): VendorConnector[] {
  return [new BeautyfortConnector(), new BtsConnector()];
}

export function createConnector(slug: string): VendorConnector {
  const found = createConnectors().find((c) => c.slug === slug);
  if (!found) throw new Error(`Unknown vendor "${slug}"`);
  return found;
}
