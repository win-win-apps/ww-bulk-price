import Papa from "papaparse";
import type { VariantRow } from "./shopify-queries.server";

// Columns for the exported CSV
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
  "current_cost",
  "new_cost",
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
    current_cost: v.cost ?? "",
    new_cost: v.cost ?? "",
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
  new_compare_at_price?: string;
  current_cost?: string;
  new_cost?: string;
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
  const rows: ParsedCsvRow[] = [];
  for (const r of parsed.data) {
    const variantId = (r["variant_id"] || "").trim();
    if (!variantId) continue;
    rows.push({
      variant_id: variantId,
      current_price: r["current_price"]?.trim(),
      new_price: r["new_price"]?.trim(),
      current_compare_at_price: r["current_compare_at_price"]?.trim(),
      new_compare_at_price: r["new_compare_at_price"]?.trim(),
      current_cost: r["current_cost"]?.trim(),
      new_cost: r["new_cost"]?.trim(),
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
    const newPrice = r.new_price || cur.price;
    const newCompare = r.new_compare_at_price !== undefined && r.new_compare_at_price !== ""
      ? r.new_compare_at_price
      : cur.compareAtPrice;

    // Validate numeric
    const newPriceNum = Number(newPrice);
    if (Number.isNaN(newPriceNum) || newPriceNum < 0) {
      errors.push(`Invalid price for ${r.variant_id}: ${newPrice}`);
      continue;
    }
    if (newCompare !== null && newCompare !== "" && newCompare !== undefined) {
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
    if (pctChange !== null && pctChange <= -50) flags.push("big_drop");
    if (pctChange !== null && pctChange >= 200) flags.push("big_increase");

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
        compareAtPrice:
          newCompare === "" || newCompare === undefined || newCompare === null
            ? null
            : String(newCompare),
      },
      priceChanged,
      compareChanged,
      pctChange,
      flags,
    });
  }
  return { diffs, errors };
}
