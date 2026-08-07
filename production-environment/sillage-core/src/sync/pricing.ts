/**
 * Pure pricing and visibility rules. No database imports — unit-testable against DATA-PROFILE edge cases.
 *
 * Storefront price is always cost × fx × multiplier. Vendor recommended retail (RRP) is ignored:
 * BTS publishes zeros on ~46% of rows and absurd outliers (up to 42,795), so using RRP as a
 * "was/now" strike-through misleads customers and hides the multiplier effect.
 */

export interface PricingInput {
  vendorPrice: number;
  /** Accepted for API compatibility; never used for storefront price. */
  vendorRecommendedPrice: number | null;
  stock: number;
}

export interface PricingRules {
  /** Plain float. 0.5, 1.2 and 2 are all valid. */
  multiplier: number;
  fxRate: number;
  /** Inclusive: stock <= threshold hides the product. */
  stockThreshold: number;
  /** Kept for settings compatibility; unused after RRP was dropped. */
  maxRrpRatio: number;
}

export interface PricingResult {
  regularPrice: number;
  salePrice: number | null;
  effectivePrice: number;
  onSale: boolean;
  stock: number;
  stockStatus: "instock" | "outofstock";
  hidden: boolean;
}

export const DEFAULT_RULES: PricingRules = {
  multiplier: 1.0,
  fxRate: 1.0,
  stockThreshold: 0,
  maxRrpRatio: 10,
};

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function computePricing(input: PricingInput, rules: PricingRules): PricingResult {
  void input.vendorRecommendedPrice;
  void rules.maxRrpRatio;

  const computed = round2(input.vendorPrice * rules.fxRate * rules.multiplier);
  // Never free: a tiny multiplier that rounds to 0 becomes 0.01.
  const price = computed > 0 ? computed : 0.01;
  const stock = Math.max(0, Math.trunc(input.stock));
  const hidden = stock <= rules.stockThreshold;

  return {
    regularPrice: price,
    salePrice: null,
    effectivePrice: price,
    onSale: false,
    stock,
    stockStatus: hidden || stock <= 0 ? "outofstock" : "instock",
    hidden,
  };
}

export function resolveRules(
  global: { multiplier: number; stockThreshold: number; maxRrpRatio: number },
  vendor: { priceMultiplier: number | null; minVisibleStock: number | null; fxRate: number },
): PricingRules {
  return {
    multiplier: vendor.priceMultiplier ?? global.multiplier,
    fxRate: vendor.fxRate,
    stockThreshold: vendor.minVisibleStock ?? global.stockThreshold,
    maxRrpRatio: global.maxRrpRatio,
  };
}
