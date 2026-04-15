// Build diffs from a percentage/fixed adjustment rule (no CSV needed)
import type { VariantRow } from "./shopify-queries.server";
import type { DiffRow } from "./csv.server";

export type AdjustmentScope = "all" | "variant_ids";
export type AdjustmentField = "price" | "compare_at_price";
export type AdjustmentMode = "percent" | "fixed";
export type RoundingRule = "none" | "end_99" | "end_95" | "end_00";

export type AdjustmentInput = {
  scope: AdjustmentScope;
  variantIds?: string[];
  field: AdjustmentField;
  mode: AdjustmentMode;
  amount: number; // percent: e.g. 10 = +10%, -5 = -5%. fixed: e.g. 2.50 or -2.50
  rounding: RoundingRule;
};

function applyRounding(value: number, rule: RoundingRule): number {
  if (Number.isNaN(value)) return value;
  // Helper: round to nearest X.NN where NN is a given fractional endpoint.
  // Example: roundToEnding(10.50, 0.99) -> picks the closest of 9.99 or 10.99.
  const roundToEnding = (v: number, ending: number) => {
    const whole = Math.floor(v);
    const candidateLow = Math.max(0, whole - 1) + ending; // e.g. 9.99
    const candidateHigh = whole + ending; // e.g. 10.99
    // Pick whichever is closest to v. Ties go to the higher one for nicer UX.
    const distLow = Math.abs(v - candidateLow);
    const distHigh = Math.abs(v - candidateHigh);
    return distHigh <= distLow ? candidateHigh : candidateLow;
  };
  switch (rule) {
    case "end_99":
      return Math.max(0, roundToEnding(value, 0.99));
    case "end_95":
      return Math.max(0, roundToEnding(value, 0.95));
    case "end_00":
      // Round to nearest whole dollar.
      return Math.max(0, Math.round(value));
    case "none":
    default:
      // Default: cent precision, no charm pricing.
      return Math.max(0, Math.round(value * 100) / 100);
  }
}

export function buildAdjustmentDiffs(input: AdjustmentInput, variants: VariantRow[]): DiffRow[] {
  const target = new Set(input.variantIds ?? []);
  const diffs: DiffRow[] = [];
  for (const v of variants) {
    if (input.scope === "variant_ids" && !target.has(v.variantId)) continue;

    const field = input.field;
    const currentStr = field === "price" ? v.price : v.compareAtPrice;
    if (currentStr == null || currentStr === "") continue;
    const currentNum = Number(currentStr);
    if (Number.isNaN(currentNum)) continue;

    let newNum: number;
    if (input.mode === "percent") {
      newNum = currentNum * (1 + input.amount / 100);
    } else {
      newNum = currentNum + input.amount;
    }
    newNum = applyRounding(newNum, input.rounding);
    if (newNum < 0) newNum = 0;

    const priceChanged = field === "price" && newNum.toFixed(2) !== Number(v.price).toFixed(2);
    const compareChanged = field === "compare_at_price" && (v.compareAtPrice == null ? true : newNum.toFixed(2) !== Number(v.compareAtPrice).toFixed(2));
    if (!priceChanged && !compareChanged) continue;

    const pct = currentNum > 0 ? ((newNum - currentNum) / currentNum) * 100 : null;
    const flags: string[] = [];
    if (pct !== null && pct <= -25) flags.push("big_drop");
    if (pct !== null && pct >= 100) flags.push("big_increase");

    diffs.push({
      variantId: v.variantId,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      before: { price: v.price, compareAtPrice: v.compareAtPrice },
      after: {
        price: field === "price" ? newNum.toFixed(2) : v.price,
        compareAtPrice: field === "compare_at_price" ? newNum.toFixed(2) : v.compareAtPrice,
      },
      priceChanged,
      compareChanged,
      pctChange: pct,
      flags,
    });
  }
  return diffs;
}
