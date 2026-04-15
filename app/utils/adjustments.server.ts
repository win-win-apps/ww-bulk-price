// Build diffs from a percentage/fixed adjustment rule (no CSV needed).
//
// Matches the NA Bulk Price Editor layout:
//   Step 2: price + compare_at rules
//   Step 3: scope. Three modes:
//     - all         : every variant
//     - specific    : explicit product ids + variant ids (from the resource picker)
//     - conditions  : array of condition rows combined with AND or OR
import type { VariantRow } from "./shopify-queries.server";
import type { DiffRow } from "./csv.server";

export type AdjustmentScope = "all" | "specific" | "conditions";
export type AdjustmentMode = "percent" | "fixed" | "set_to";
export type RoundingRule = "none" | "end_99" | "end_95" | "end_00";

// Compare-at behaviour. Matches NA's "Compare at price" dropdown:
//   leave      = do not touch compare_at
//   sale       = set compare_at to the CURRENT regular price so the storefront
//                shows a strikethrough. This is how NA builds a sale.
//   clear      = remove compare_at
//   percent    = adjust compare_at by the same percentage as price
//   fixed      = adjust compare_at by a fixed amount
export type CompareAtMode = "leave" | "sale" | "clear" | "percent" | "fixed";

// Condition fields. Matches the dropdown in NA bulk price editor.
// product_collection matches against the variant's product's collection ids,
// which are loaded with the variants query. Everything else reads straight off
// VariantRow so the match runs at zero extra API cost.
export type ConditionField =
  | "product_collection"
  | "product_title"
  | "product_type"
  | "vendor"
  | "tag"
  | "variant_title"
  | "product_status"
  | "gift_card"
  | "inventory_quantity";

// Operator set. Different fields accept different subsets. The UI picks which
// operators to show based on the field type.
export type ConditionOperator =
  | "is"           // equals
  | "is_not"       // not equals
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "gt"           // numeric only
  | "lt"
  | "gte"
  | "lte";

export type Condition = {
  field: ConditionField;
  operator: ConditionOperator;
  value: string; // always stored as string; numeric fields parse on eval
};

export type Conjunction = "AND" | "OR";

export type AdjustmentInput = {
  scope: AdjustmentScope;
  // "specific" mode: either whole products (every variant of these product ids)
  // OR explicit variant ids. Both can be set and are OR'd together.
  productIds?: string[];
  variantIds?: string[];
  // "conditions" mode
  conditions?: Condition[];
  conjunction?: Conjunction;
  // Price rule (applies to regular price)
  mode: AdjustmentMode;
  amount: number;
  rounding: RoundingRule;
  // Compare-at rule
  compareAt: CompareAtMode;
  compareAtAmount?: number; // only for percent/fixed compare_at modes
};

function applyRounding(value: number, rule: RoundingRule): number {
  if (Number.isNaN(value)) return value;
  const roundToEnding = (v: number, ending: number) => {
    const whole = Math.floor(v);
    const candidateLow = Math.max(0, whole - 1) + ending;
    const candidateHigh = whole + ending;
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
      return Math.max(0, Math.round(value));
    case "none":
    default:
      return Math.max(0, Math.round(value * 100) / 100);
  }
}

function applyPriceRule(current: number, mode: AdjustmentMode, amount: number): number {
  if (mode === "percent") return current * (1 + amount / 100);
  if (mode === "fixed") return current + amount;
  if (mode === "set_to") return amount;
  return current;
}

// Compare two strings with one of the text operators. Case insensitive.
function textOp(haystack: string, op: ConditionOperator, needle: string): boolean {
  const h = (haystack || "").toLowerCase().trim();
  const n = (needle || "").toLowerCase().trim();
  switch (op) {
    case "is": return h === n;
    case "is_not": return h !== n;
    case "contains": return n.length === 0 ? true : h.includes(n);
    case "not_contains": return n.length === 0 ? true : !h.includes(n);
    case "starts_with": return h.startsWith(n);
    case "ends_with": return h.endsWith(n);
    default: return false;
  }
}

function numericOp(value: number | null, op: ConditionOperator, target: number): boolean {
  if (value == null || Number.isNaN(value) || Number.isNaN(target)) return false;
  switch (op) {
    case "is":
    case "is_not": {
      const eq = value === target;
      return op === "is" ? eq : !eq;
    }
    case "gt": return value > target;
    case "lt": return value < target;
    case "gte": return value >= target;
    case "lte": return value <= target;
    default: return false;
  }
}

function evalCondition(v: VariantRow, c: Condition): boolean {
  switch (c.field) {
    case "product_collection": {
      // value is a collection id (gid://shopify/Collection/123)
      const ids = v.collectionIds || [];
      if (c.operator === "is") return ids.includes(c.value);
      if (c.operator === "is_not") return !ids.includes(c.value);
      return false;
    }
    case "product_title": return textOp(v.productTitle, c.operator, c.value);
    case "product_type": return textOp(v.productType, c.operator, c.value);
    case "vendor": return textOp(v.vendor, c.operator, c.value);
    case "variant_title": return textOp(v.variantTitle, c.operator, c.value);
    case "tag": {
      // tag is special: any of the variant's tags matches the operator against the value
      const tags = (v.tags || []).map((t) => t.toLowerCase().trim());
      const needle = (c.value || "").toLowerCase().trim();
      switch (c.operator) {
        case "is": return tags.includes(needle);
        case "is_not": return !tags.includes(needle);
        case "contains": return tags.some((t) => t.includes(needle));
        case "not_contains": return tags.every((t) => !t.includes(needle));
        case "starts_with": return tags.some((t) => t.startsWith(needle));
        case "ends_with": return tags.some((t) => t.endsWith(needle));
        default: return false;
      }
    }
    case "product_status": {
      // value should be ACTIVE / DRAFT / ARCHIVED
      const status = (v.productStatus || "").toUpperCase();
      const target = (c.value || "").toUpperCase();
      if (c.operator === "is") return status === target;
      if (c.operator === "is_not") return status !== target;
      return false;
    }
    case "gift_card": {
      // value is "true" or "false"
      const want = (c.value || "").toLowerCase() === "true";
      if (c.operator === "is") return v.isGiftCard === want;
      if (c.operator === "is_not") return v.isGiftCard !== want;
      return false;
    }
    case "inventory_quantity": {
      const target = Number(c.value);
      return numericOp(v.inventoryQuantity, c.operator, target);
    }
    default: return false;
  }
}

export function matchesConditions(v: VariantRow, conditions: Condition[], conjunction: Conjunction): boolean {
  if (!conditions || conditions.length === 0) return true;
  if (conjunction === "OR") {
    return conditions.some((c) => evalCondition(v, c));
  }
  return conditions.every((c) => evalCondition(v, c));
}

export function buildAdjustmentDiffs(input: AdjustmentInput, variants: VariantRow[]): DiffRow[] {
  const productSet = new Set(input.productIds ?? []);
  const variantSet = new Set(input.variantIds ?? []);
  const diffs: DiffRow[] = [];
  for (const v of variants) {
    if (input.scope === "specific") {
      const inProducts = productSet.has(v.productId);
      const inVariants = variantSet.has(v.variantId);
      if (!inProducts && !inVariants) continue;
    } else if (input.scope === "conditions") {
      if (!matchesConditions(v, input.conditions || [], input.conjunction || "AND")) continue;
    }
    // scope === "all" falls through

    const currentPriceStr = v.price;
    if (currentPriceStr == null || currentPriceStr === "") continue;
    const currentPriceNum = Number(currentPriceStr);
    if (Number.isNaN(currentPriceNum)) continue;

    // Compute new regular price
    let newPriceNum = applyPriceRule(currentPriceNum, input.mode, input.amount);
    newPriceNum = applyRounding(newPriceNum, input.rounding);
    if (newPriceNum < 0) newPriceNum = 0;

    // Compute new compare-at
    const currentCompareStr = v.compareAtPrice;
    const currentCompareNum = currentCompareStr != null && currentCompareStr !== "" ? Number(currentCompareStr) : null;
    let newCompareStr: string | null = currentCompareStr;
    switch (input.compareAt) {
      case "leave":
        newCompareStr = currentCompareStr;
        break;
      case "sale":
        // Strikethrough: compare_at becomes the ORIGINAL price, regular becomes the sale price
        newCompareStr = currentPriceNum.toFixed(2);
        break;
      case "clear":
        newCompareStr = null;
        break;
      case "percent": {
        const base = currentCompareNum != null && !Number.isNaN(currentCompareNum) ? currentCompareNum : currentPriceNum;
        const amt = input.compareAtAmount ?? input.amount;
        let nc = applyRounding(base * (1 + amt / 100), input.rounding);
        if (nc < 0) nc = 0;
        newCompareStr = nc.toFixed(2);
        break;
      }
      case "fixed": {
        const base = currentCompareNum != null && !Number.isNaN(currentCompareNum) ? currentCompareNum : currentPriceNum;
        const amt = input.compareAtAmount ?? input.amount;
        let nc = applyRounding(base + amt, input.rounding);
        if (nc < 0) nc = 0;
        newCompareStr = nc.toFixed(2);
        break;
      }
    }

    const priceChanged = newPriceNum.toFixed(2) !== currentPriceNum.toFixed(2);
    const compareChanged = (() => {
      if (newCompareStr == null && currentCompareStr == null) return false;
      if (newCompareStr == null || currentCompareStr == null) return true;
      return Number(newCompareStr).toFixed(2) !== Number(currentCompareStr).toFixed(2);
    })();
    if (!priceChanged && !compareChanged) continue;

    const pct = currentPriceNum > 0 ? ((newPriceNum - currentPriceNum) / currentPriceNum) * 100 : null;
    const flags: string[] = [];
    if (pct !== null && pct <= -25) flags.push("big_drop");
    if (pct !== null && pct >= 100) flags.push("big_increase");

    diffs.push({
      variantId: v.variantId,
      productId: v.productId,
      productTitle: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      imageUrl: v.imageUrl,
      before: { price: v.price, compareAtPrice: v.compareAtPrice },
      after: {
        price: newPriceNum.toFixed(2),
        compareAtPrice: newCompareStr,
      },
      priceChanged,
      compareChanged,
      pctChange: pct,
      flags,
    });
  }
  return diffs;
}

function describeScope(input: AdjustmentInput): string {
  if (input.scope === "all") return "all products";
  if (input.scope === "specific") {
    const p = input.productIds?.length || 0;
    const v = input.variantIds?.length || 0;
    if (p > 0 && v > 0) return `${p} selected product${p === 1 ? "" : "s"} and ${v} variant${v === 1 ? "" : "s"}`;
    if (p > 0) return `${p} selected product${p === 1 ? "" : "s"}`;
    if (v > 0) return `${v} selected variant${v === 1 ? "" : "s"}`;
    return "selected products";
  }
  if (input.scope === "conditions") {
    const n = input.conditions?.length || 0;
    const conj = input.conjunction === "OR" ? "any" : "all";
    return n === 0 ? "all products" : `products matching ${conj} of ${n} condition${n === 1 ? "" : "s"}`;
  }
  return "products";
}

/**
 * Generate a human readable description of what an apply run does.
 * Called from the action when the run is created so it is stored on the
 * ApplyRun row and can be read back by the history page without recomputing.
 */
export function describeAdjustment(input: AdjustmentInput, diffCount: number): string {
  const noun = diffCount === 1 ? "variant" : "variants";
  const scopeBit = describeScope(input);

  let priceBit = "";
  if (input.mode === "percent") {
    const verb = input.amount >= 0 ? "Raises" : "Lowers";
    priceBit = `${verb} prices of ${diffCount} ${noun} (${scopeBit}) by ${Math.abs(input.amount)}%`;
  } else if (input.mode === "fixed") {
    const verb = input.amount >= 0 ? "Raises" : "Lowers";
    const absAmt = Math.abs(input.amount).toFixed(2);
    priceBit = `${verb} prices of ${diffCount} ${noun} (${scopeBit}) by $${absAmt}`;
  } else if (input.mode === "set_to") {
    priceBit = `Sets prices of ${diffCount} ${noun} (${scopeBit}) to $${input.amount.toFixed(2)}`;
  }

  let compareBit = "";
  if (input.compareAt === "sale") compareBit = ", original price moved to compare-at (strikethrough)";
  else if (input.compareAt === "clear") compareBit = ", compare-at cleared";
  else if (input.compareAt === "percent") compareBit = `, compare-at adjusted ${input.compareAtAmount ?? input.amount}%`;
  else if (input.compareAt === "fixed") compareBit = `, compare-at adjusted by $${input.compareAtAmount ?? input.amount}`;

  return priceBit + compareBit;
}
