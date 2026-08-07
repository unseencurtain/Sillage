/**
 * Pure pricing and visibility rules. No database imports here, so this file is directly
 * unit-testable against the edge cases measured in docs/DATA-PROFILE.md.
 */

export interface PricingInput {
  vendorPrice: number;
  vendorRecommendedPrice: number | null;
  stock: number;
}

export interface PricingRules {
  /** Plain float. 0.5, 1.2 and 2 are all valid — no percentage arithmetic. */
  multiplier: number;
  /** 1.0 for both current vendors; exists so a non-EUR vendor needs no schema change. */
  fxRate: number;
  /** Inclusive: stock <= threshold hides the product. */
  stockThreshold: number;
  /**
   * Upper bound on how far an RRP may exceed our price before we distrust it.
   *
   * BTS publishes `recommended_price` of 0 on 46% of rows and a maximum of 42,795 against a real
   * price ceiling of 889. Without this the storefront advertises "was EUR 42,795, now EUR 30".
   */
  maxRrpRatio: number;
}

export interface PricingResult {
  regularPrice: number;
  salePrice: number | null;
  /** What `_price` and the lookup table's min/max price must equal. */
  effectivePrice: number;
  onSale: boolean;
  stock: number;
  stockStatus: "instock" | "outofstock";
  /** Excluded from catalog and search, and forced out of stock. */
  hidden: boolean;
}

export const DEFAULT_RULES: PricingRules = {
  multiplier: 1.0,
  fxRate: 1.0,
  stockThreshold: 0,
  maxRrpRatio: 10,
};

export function round2(value: number): number {
  // Nudge by an epsilon before rounding so binary representations like 1.005 round the way a
  // human expects rather than down.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function computePricing(input: PricingInput, rules: PricingRules): PricingResult {
  const computed = round2(input.vendorPrice * rules.fxRate * rules.multiplier);
  // A multiplier small enough to round to zero would make the product free.
  const effectiveBase = computed > 0 ? computed : 0.01;

  const rrp = input.vendorRecommendedPrice;
  const rrpUsable =
    rrp !== null &&
    Number.isFinite(rrp) &&
    rrp > 0 &&
    rrp > effectiveBase &&
    rrp <= effectiveBase * rules.maxRrpRatio;

  const regularPrice = rrpUsable ? round2(rrp) : effectiveBase;
  const salePrice = rrpUsable ? effectiveBase : null;
  const effectivePrice = salePrice ?? regularPrice;

  const stock = Math.max(0, Math.trunc(input.stock));
  const hidden = stock <= rules.stockThreshold;

  return {
    regularPrice,
    salePrice,
    effectivePrice,
    onSale: salePrice !== null,
    stock,
    // Hidden products are forced out of stock too, otherwise a direct link still adds to cart.
    stockStatus: hidden || stock <= 0 ? "outofstock" : "instock",
    hidden,
  };
}

/** Per-vendor overrides fall back to the global default when null. */
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
