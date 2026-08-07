import { BeautyfortConnector } from "./beautyfort/connector.ts";
import { BtsConnector } from "./bts/connector.ts";
import { WholesalePerfumesConnector } from "./wholesale-perfumes/connector.ts";
import type { VendorConnector } from "./VendorConnector.ts";

/**
 * Adding a vendor: implement VendorConnector, add it here, add a row to sil_vendors. No PHP
 * changes and no schema changes.
 */
export function createConnectors(): VendorConnector[] {
  return [new BeautyfortConnector(), new BtsConnector(), new WholesalePerfumesConnector()];
}

export function createConnector(slug: string): VendorConnector {
  const found = createConnectors().find((c) => c.slug === slug);
  if (!found) throw new Error(`Unknown vendor "${slug}"`);
  return found;
}
