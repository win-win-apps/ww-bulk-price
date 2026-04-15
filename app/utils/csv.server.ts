import Papa from "papaparse";
import type { VariantRow } from "./shopify-queries.server";

// Columns for the exported CSV
// Note: cost is intentionally excluded. We fetch it for display/context but
// do not support writing it in v1, so shipping it as an editable column would
// silently drop merchant edits. Coming in v1.1.
export const CSV_COLUMNS = [
  "variant_id",
  "product_handle",
  "product_title",
  "variant_title",
  "sku",
  "currency",
  "current_price",
  "new_price",
  "current_compare_at_price",
  "new_compare_at_price",
] as const;

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>;

export function variantsToCsvRows(variants: VariantRow[]): CsvRow[] {
  return variants.map((v) => ({
    variant_id: v.variantId,
    product_handle: v.productHandle,
    product_title: v.productTitle,
    variant_title: v.variantTitle,
    sku: v.sku ?? "",
    currency: v.currencyCode,
    current_price: v.price,
    new_price: v.price, // Pre-fill with current so merchants can edit in place
    current_compare_at_price: v.compareAtPrice ?? "",
    new_compare_at_price: v.compareAtPrice ?? "",
  }));
}

export function serializeCsv(rows: CsvRow[]): string {
  return Papa.unparse(
    {
      fields: CSV_COLUMNS as unknown as string[],
      data: rows,
    },
    { newline: "\n" }
  );
}

export type ParsedCsvRow = {
  variant_id: string;
  current_price?: string;
  new_price?: string;
  current_compare_at_price?: string;
  // new_compare_at_price is a 3-state value:
  //   undefined = column was not present in the CSV, keep current
  //   "" (empty string) = column present but cell blank, clear compare_at
  //   non-empty string = set compare_at to that value
  new_compare_at_price?: string;
};

export type ParseResult = {
  rows: ParsedCsvRow[];
  errors: string[];
};

export function parseCsv(text: string): ParseResult {
  const errors: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) errors.push(`Row ${e.row}: ${e.message}`);
  }
  const requiredCol = "variant_id";
  if (parsed.meta.fields && !parsed.meta.fields.includes(requiredCol)) {
    errors.push(`CSV is missing required column: ${requiredCol}`);
    return { rows: [], errors };
  }
  // Track which headers were actually present so we can distinguish
  // "column missing" (undefined) from "cell blank" ("") at the row level.
  const headerSet = new Set(parsed.meta.fields ?? []);
  const has = (col: string) => headerSet.has(col);
  const pick = (r: Record<string, string>, col: string): string | undefined => {
    if (!has(col)) return undefined;
    const v = r[col];
    return typeof v === "string" ? v.trim() : "";
  };

  const rows: ParsedCsvRow[] = [];
  for (const r of parsed.data) {
    const variantId = (r["variant_id"] || "").trim();
    if (!variantId) continue;
    rows.push({
      variant_id: variantId,
      current_price: pick(r, "current_price"),
      new_price: pick(r, "new_price"),
      current_compare_at_price: pick(r, "current_compare_at_price"),
      new_compare_at_price: pick(r, "new_compare_at_price"),
    });
  }
  return { rows, errors };
}

export type DiffRow = {
  variantId: string;
  productId?: string;
  productTitle?: string;
  variantTitle?: string;
  sku?: string | null;
  before: { price: string; compareAtPrice: string | null };
  after: { price: string; compareAtPrice: string | null };
  priceChanged: boolean;
  compareChanged: boolean;
  pctChange: number | null; // null if no change or current is 0
  flags: string[]; // e.g. "big_drop"
};

export function computeDiff(parsedRows: ParsedCsvRow[], current: VariantRow[]): { diffs: DiffRow[]; errors: string[] } {
  const errors: string[] = [];
  const currentMap = new Map<string, VariantRow>();
  for (const v of current) currentMap.set(v.variantId, v);

  const diffs: DiffRow[] = [];
  for (const r of parsedRows) {
    const cur = currentMap.get(r.variant_id);
    if (!cur) {
      errors.push(`Unknown variant: ${r.variant_id}`);
      continue;
    }
    // new_price: if column missing or cell blank, keep current. No way to clear a price.
    const newPrice = r.new_price && r.new_price !== "" ? r.new_price : cur.price;

    // new_compare_at_price: 3-state
    //   undefined -> column missing, keep current compare_at
    //   "" -> column present but blank, CLEAR compare_at (set to null on shopify)
    //   value -> set to value
    let newCompare: string | null;
    if (r.new_compare_at_price === undefined) {
      newCompare = cur.compareAtPrice;
    } else if (r.new_compare_at_price === "") {
      newCompare = null;
    } else {
      newCompare = r.new_compare_at_price;
    }

    // Validate numeric
    const newPriceNum = Number(newPrice);
    if (Number.isNaN(newPriceNum) || newPriceNum < 0) {
      errors.push(`Invalid price for ${r.variant_id}: ${newPrice}`);
      continue;
    }
    if (newCompare !== null && newCompare !== "") {
      const n = Number(newCompare);
      if (Number.isNaN(n) || n < 0) {
        errors.push(`Invalid compare-at price for ${r.variant_id}: ${newCompare}`);
        continue;
      }
    }

    const priceChanged = String(cur.price) !== String(newPrice);
    const compareChanged = String(cur.compareAtPrice ?? "") !== String(newCompare ?? "");

    let pctChange: number | null = null;
    const curNum = Number(cur.price);
    if (!Number.isNaN(curNum) && curNum > 0) {
      pctChange = ((newPriceNum - curNum) / curNum) * 100;
    }
    const flags: string[] = [];
    // Merchant-sensible: 25% drop is a real sale worth noticing, 100%+ increase
    // usually means a decimal typo (e.g. 19.99 -> 199.9).
    if (pctChange !== null && pctChange <= -25) flags.push("big_drop");
    if (pctChange !== null && pctChange >= 100) flags.push("big_increase");

    if (!priceChanged && !compareChanged) continue; // Unchanged rows are silently dropped

    diffs.push({
      variantId: r.variant_id,
      productId: cur.productId,
      productTitle: cur.productTitle,
      variantTitle: cur.variantTitle,
      sku: cur.sku,
      before: { price: cur.price, compareAtPrice: cur.compareAtPrice },
      after: {
        price: String(newPrice),
        compareAtPrice: newCompare === null || newCompare === "" ? null : String(newCompare),
      },
      priceChanged,
      compareChanged,
      pctChange,
      flags,
    });
  }
  return { diffs, errors };
}
