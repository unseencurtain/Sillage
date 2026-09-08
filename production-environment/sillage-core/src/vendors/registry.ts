import { env, type SillageProfile } from "../config/env.ts";
import { BeautyfortConnector } from "./beautyfort/connector.ts";
import { BtsConnector } from "./bts/connector.ts";
import { WholesalePerfumesConnector } from "./wholesale-perfumes/connector.ts";
import type { VendorConnector } from "./VendorConnector.ts";

/** On the LPS retail shop, wholesale-perfumes is never selected by `--vendor=all`. */
export const RETAIL_PARKED_VENDOR_SLUGS = new Set(["wholesale-perfumes"]);

/** On the wholesale shop, BeautyFort and BTS are never selected — even with an explicit slug. */
export const WHOLESALE_PARKED_VENDOR_SLUGS = new Set(["beautyfort", "bts"]);

/** @deprecated use parkedVendorSlugsFor("retail") — kept so older tests still compile. */
export const PARKED_B2B_VENDOR_SLUGS = RETAIL_PARKED_VENDOR_SLUGS;

export function parkedVendorSlugsFor(profile: SillageProfile = env.sillageProfile): Set<string> {
  return profile === "wholesale" ? WHOLESALE_PARKED_VENDOR_SLUGS : RETAIL_PARKED_VENDOR_SLUGS;
}

export function isParkedVendor(slug: string, profile: SillageProfile = env.sillageProfile): boolean {
  return parkedVendorSlugsFor(profile).has(slug);
}

/** Vendors this storefront’s dashboard and scheduler should sync. */
export function storefrontVendorSlugs(profile: SillageProfile = env.sillageProfile): string[] {
  return profile === "wholesale" ? ["wholesale-perfumes"] : ["beautyfort", "bts"];
}

/**
 * Retail: parked B2B slug. Wholesale: parked retail slugs.
 * Prefer `isParkedVendor` in new code.
 */
export function isParkedB2bVendor(slug: string): boolean {
  return isParkedVendor(slug);
}

/**
 * `--vendor=all` never includes parked slugs.
 * Retail still allows an explicit `--vendor=wholesale-perfumes` for offline tests.
 * Wholesale refuses BeautyFort / BTS even when named explicitly.
 */
export function vendorSelectableForSync(
  slug: string,
  explicit: boolean,
  profile: SillageProfile = env.sillageProfile,
): boolean {
  if (!isParkedVendor(slug, profile)) return true;
  if (profile === "wholesale") return false;
  return explicit;
}

/**
 * Adding a vendor: implement VendorConnector, add it here, add a row to sil_vendors. No PHP
 * changes and no schema changes.
 *
 * Connectors stay registered on both storefronts so tests and history work. Sync selection
 * (not this list) is what parks a supplier.
 */
export function createConnectors(): VendorConnector[] {
  return [new BeautyfortConnector(), new BtsConnector(), new WholesalePerfumesConnector()];
}

export function createConnector(slug: string): VendorConnector {
  const found = createConnectors().find((c) => c.slug === slug);
  if (!found) throw new Error(`Unknown vendor "${slug}"`);
  return found;
}
