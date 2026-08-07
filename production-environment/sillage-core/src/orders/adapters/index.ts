import type { VendorOrderAdapter } from "../adapter.ts";
import { BeautyfortOrderAdapter } from "./beautyfort.ts";
import { BtsOrderAdapter } from "./bts.ts";

export function createOrderAdapters(): VendorOrderAdapter[] {
  return [new BeautyfortOrderAdapter(), new BtsOrderAdapter()];
}

export function createOrderAdapter(slug: string): VendorOrderAdapter {
  const found = createOrderAdapters().find((a) => a.slug === slug);
  if (!found) throw new Error(`No order adapter for vendor "${slug}"`);
  return found;
}
