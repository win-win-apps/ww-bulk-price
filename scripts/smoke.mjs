// Standalone smoke test for csv + adjustment + diff logic.
// Does not talk to Shopify. Run with: node scripts/smoke.mjs
import Papa from "papaparse";

// Re-import the pure modules as ESM.
import { variantsToCsvRows, serializeCsv, parseCsv, computeDiff } from "../app/utils/csv.server.ts";
import { buildAdjustmentDiffs } from "../app/utils/adjustments.server.ts";

const fake = [
  { productId: "gid://shopify/Product/1", productTitle: "Tee", productHandle: "tee", variantId: "gid://shopify/ProductVariant/1001", variantTitle: "S", sku: "TEE-S", price: "20.00", compareAtPrice: null, cost: "7.00", inventoryItemId: "gid://shopify/InventoryItem/2001", currencyCode: "USD" },
  { productId: "gid://shopify/Product/1", productTitle: "Tee", productHandle: "tee", variantId: "gid://shopify/ProductVariant/1002", variantTitle: "M", sku: "TEE-M", price: "20.00", compareAtPrice: "25.00", cost: "7.00", inventoryItemId: "gid://shopify/InventoryItem/2002", currencyCode: "USD" },
  { productId: "gid://shopify/Product/2", productTitle: "Hat", productHandle: "hat", variantId: "gid://shopify/ProductVariant/1003", variantTitle: "Default", sku: "HAT", price: "15.00", compareAtPrice: null, cost: null, inventoryItemId: null, currencyCode: "USD" },
];

console.log("1. csv export roundtrip...");
const rows = variantsToCsvRows(fake);
const csv = serializeCsv(rows);
console.log(csv);

console.log("2. parse csv with 1 edited row...");
const edited = csv.replace("20.00,20.00", "20.00,17.99"); // bump tee S new_price
const parsed = parseCsv(edited);
console.log("parsed rows:", parsed.rows.length, "errors:", parsed.errors);

console.log("3. diff...");
const diff = computeDiff(parsed.rows, fake);
console.log("diffs:", JSON.stringify(diff.diffs, null, 2));
console.log("errors:", diff.errors);

console.log("4. percent adjustment, +10 on all prices, round end_99...");
const adj = buildAdjustmentDiffs({ scope: "all", field: "price", mode: "percent", amount: 10, rounding: "end_99" }, fake);
console.log("adj diffs:", JSON.stringify(adj, null, 2));

console.log("5. fixed adjustment, -5 on compare_at_price only...");
const adj2 = buildAdjustmentDiffs({ scope: "all", field: "compare_at_price", mode: "fixed", amount: -5, rounding: "none" }, fake);
console.log("adj2 diffs:", JSON.stringify(adj2, null, 2));

console.log("smoke test complete");
