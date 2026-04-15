// end to end logic test against the real win-win-ccae-dev shop
// Uses the offline session token from postgres, exercises the full
// fetch -> csv -> parse -> diff -> apply -> verify -> revert chain.

import Papa from "papaparse";

const SHOP = "win-win-ccae-dev.myshopify.com";
const TOKEN = process.env.WWBP_TOKEN;
if (!TOKEN) {
  console.error("Set WWBP_TOKEN env var");
  process.exit(2);
}

const API = `https://${SHOP}/admin/api/2025-01/graphql.json`;

let failCount = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failCount++;
  }
}
function section(name) {
  console.log(`\n== ${name} ==`);
}

async function gql(query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error("GraphQL: " + JSON.stringify(body.errors));
  return body.data;
}

// ---------- pure logic copies from the app, to avoid importing .ts files ----------

const CSV_COLUMNS = [
  "variant_id", "product_handle", "product_title", "variant_title", "sku",
  "currency", "current_price", "new_price", "current_compare_at_price", "new_compare_at_price",
];

function variantsToCsvRows(variants) {
  return variants.map((v) => ({
    variant_id: v.variantId,
    product_handle: v.productHandle,
    product_title: v.productTitle,
    variant_title: v.variantTitle,
    sku: v.sku ?? "",
    currency: v.currencyCode,
    current_price: v.price,
    new_price: v.price,
    current_compare_at_price: v.compareAtPrice ?? "",
    new_compare_at_price: v.compareAtPrice ?? "",
  }));
}

function serializeCsv(rows) {
  return Papa.unparse({ fields: CSV_COLUMNS, data: rows }, { newline: "\n" });
}

function parseCsv(text) {
  const errors = [];
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) errors.push(`Row ${e.row}: ${e.message}`);
  }
  if (parsed.meta.fields && !parsed.meta.fields.includes("variant_id")) {
    errors.push("CSV is missing required column: variant_id");
    return { rows: [], errors };
  }
  const headerSet = new Set(parsed.meta.fields ?? []);
  const pick = (r, col) => {
    if (!headerSet.has(col)) return undefined;
    const v = r[col];
    return typeof v === "string" ? v.trim() : "";
  };
  const rows = [];
  for (const r of parsed.data) {
    const vid = (r.variant_id || "").trim();
    if (!vid) continue;
    rows.push({
      variant_id: vid,
      current_price: pick(r, "current_price"),
      new_price: pick(r, "new_price"),
      current_compare_at_price: pick(r, "current_compare_at_price"),
      new_compare_at_price: pick(r, "new_compare_at_price"),
    });
  }
  return { rows, errors };
}

function computeDiff(parsedRows, current) {
  const errors = [];
  const map = new Map(current.map((v) => [v.variantId, v]));
  const diffs = [];
  for (const r of parsedRows) {
    const cur = map.get(r.variant_id);
    if (!cur) { errors.push(`Unknown variant: ${r.variant_id}`); continue; }
    const newPrice = r.new_price && r.new_price !== "" ? r.new_price : cur.price;
    let newCompare;
    if (r.new_compare_at_price === undefined) newCompare = cur.compareAtPrice;
    else if (r.new_compare_at_price === "") newCompare = null;
    else newCompare = r.new_compare_at_price;

    const n = Number(newPrice);
    if (Number.isNaN(n) || n < 0) { errors.push(`Invalid price for ${r.variant_id}`); continue; }
    if (newCompare !== null && newCompare !== "") {
      const c = Number(newCompare);
      if (Number.isNaN(c) || c < 0) { errors.push(`Invalid compare for ${r.variant_id}`); continue; }
    }
    const priceChanged = String(cur.price) !== String(newPrice);
    const compareChanged = String(cur.compareAtPrice ?? "") !== String(newCompare ?? "");
    if (!priceChanged && !compareChanged) continue;
    diffs.push({
      variantId: r.variant_id,
      productId: cur.productId,
      before: { price: cur.price, compareAtPrice: cur.compareAtPrice },
      after: { price: String(newPrice), compareAtPrice: newCompare === null || newCompare === "" ? null : String(newCompare) },
      priceChanged,
      compareChanged,
    });
  }
  return { diffs, errors };
}

function roundToEnding(v, ending) {
  const whole = Math.floor(v);
  const low = Math.max(0, whole - 1) + ending;
  const high = whole + ending;
  return Math.abs(v - high) <= Math.abs(v - low) ? high : low;
}
function applyRounding(value, rule) {
  switch (rule) {
    case "end_99": return Math.max(0, roundToEnding(value, 0.99));
    case "end_95": return Math.max(0, roundToEnding(value, 0.95));
    case "end_00": return Math.max(0, Math.round(value));
    default: return Math.max(0, Math.round(value * 100) / 100);
  }
}

// ---------- shopify queries ----------

async function fetchAllVariants() {
  const out = [];
  let cursor = null;
  while (true) {
    const data = await gql(`
      query Q($cursor: String) {
        productVariants(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title sku price compareAtPrice
            product { id title handle }
          }
        }
        shop { currencyCode }
      }`, { cursor });
    for (const n of data.productVariants.nodes) {
      out.push({
        productId: n.product.id,
        productTitle: n.product.title,
        productHandle: n.product.handle,
        variantId: n.id,
        variantTitle: n.title,
        sku: n.sku,
        price: n.price,
        compareAtPrice: n.compareAtPrice,
        currencyCode: data.shop.currencyCode,
      });
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
  }
  return out;
}

async function updateVariant(productId, variantId, { price, compareAtPrice }) {
  const variants = [{ id: variantId }];
  if (price !== undefined) variants[0].price = price;
  if (compareAtPrice !== undefined) variants[0].compareAtPrice = compareAtPrice;
  const data = await gql(`
    mutation M($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }`, { productId, variants });
  const errs = data.productVariantsBulkUpdate.userErrors;
  if (errs && errs.length > 0) throw new Error("update: " + JSON.stringify(errs));
  return data.productVariantsBulkUpdate.productVariants[0];
}

// ---------- tests ----------

(async () => {
  section("Fetch variants from live shop");
  const variants = await fetchAllVariants();
  assert(variants.length > 0, `fetched ${variants.length} variants`);
  const sample = variants[0];
  console.log(`  sample: ${sample.productTitle} ${sample.variantTitle} price=${sample.price} compare=${sample.compareAtPrice}`);

  section("CSV roundtrip with no edits");
  const rows = variantsToCsvRows(variants);
  const csv = serializeCsv(rows);
  const parsed = parseCsv(csv);
  assert(parsed.errors.length === 0, "parse errors empty");
  assert(parsed.rows.length === variants.length, `parsed rows == ${variants.length}`);
  const { diffs: noDiffs, errors: noErrs } = computeDiff(parsed.rows, variants);
  assert(noDiffs.length === 0, "no edits => no diffs");
  assert(noErrs.length === 0, "no edits => no errors");

  section("CSV with a single price edit");
  const edited = rows.map((r, i) => {
    if (i === 0) return { ...r, new_price: (Number(r.current_price) + 0.01).toFixed(2) };
    return r;
  });
  const editedCsv = serializeCsv(edited);
  const editedParsed = parseCsv(editedCsv);
  const editedDiff = computeDiff(editedParsed.rows, variants);
  assert(editedDiff.diffs.length === 1, `exactly 1 diff (got ${editedDiff.diffs.length})`);
  assert(editedDiff.diffs[0].priceChanged === true, "price change flagged");
  assert(editedDiff.diffs[0].compareChanged === false, "compare not flagged");

  section("CSV with compare_at cleared (empty cell)");
  const hasCompare = variants.findIndex((v) => v.compareAtPrice && Number(v.compareAtPrice) > 0);
  if (hasCompare >= 0) {
    const cleared = rows.map((r, i) => i === hasCompare ? { ...r, new_compare_at_price: "" } : r);
    const clearCsv = serializeCsv(cleared);
    const clearParsed = parseCsv(clearCsv);
    const clearDiff = computeDiff(clearParsed.rows, variants);
    const d = clearDiff.diffs.find((x) => x.variantId === variants[hasCompare].variantId);
    assert(!!d, "diff for cleared row exists");
    assert(d && d.after.compareAtPrice === null, "compareAtPrice is null after clear");
    assert(d && d.compareChanged === true, "compareChanged true");
  } else {
    console.log("  skip — no variant has compare_at set on this store");
  }

  section("CSV missing new_compare_at_price column (3-state: keep current)");
  const partialCols = ["variant_id", "new_price"];
  const partialRows = variants.slice(0, 2).map((v, i) => ({
    variant_id: v.variantId,
    new_price: (Number(v.price) + 0.01).toFixed(2),
  }));
  const partialCsv = Papa.unparse({ fields: partialCols, data: partialRows }, { newline: "\n" });
  const pParsed = parseCsv(partialCsv);
  assert(pParsed.rows.every((r) => r.new_compare_at_price === undefined), "new_compare_at_price is undefined when column missing");
  const pDiff = computeDiff(pParsed.rows, variants);
  assert(pDiff.diffs.length === 2, "2 diffs from partial csv");
  for (const d of pDiff.diffs) {
    const orig = variants.find((v) => v.variantId === d.variantId);
    assert(d.after.compareAtPrice === orig.compareAtPrice, `compareAt preserved for ${orig.variantTitle}`);
  }

  section("Rounding algorithm edge cases");
  const cases = [
    ["none", 10.506, 10.51],
    ["none", 10.504, 10.5],
    ["end_99", 10.50, 10.99], // equidistant, ties go high
    ["end_99", 10.40, 9.99],
    ["end_99", 11.10, 10.99],
    ["end_95", 10.50, 10.95],
    ["end_00", 10.40, 10],
    ["end_00", 10.60, 11],
  ];
  for (const [rule, input, expected] of cases) {
    const got = applyRounding(input, rule);
    assert(Math.abs(got - expected) < 1e-9, `${rule}(${input}) -> ${got} expected ${expected}`);
  }

  section("LIVE: apply +0.01 to one variant then revert");
  const target = variants[0];
  const oldPrice = target.price;
  const bumped = (Number(oldPrice) + 0.01).toFixed(2);
  console.log(`  target: ${target.productTitle} ${target.variantTitle} ${oldPrice} -> ${bumped}`);
  const updated = await updateVariant(target.productId, target.variantId, { price: bumped });
  assert(updated.price === bumped, `price set to ${bumped}`);
  // re-fetch to confirm
  const reFetch = await fetchAllVariants();
  const reTarget = reFetch.find((v) => v.variantId === target.variantId);
  assert(reTarget && reTarget.price === bumped, "re-fetch sees bumped price");
  // revert
  const reverted = await updateVariant(target.productId, target.variantId, { price: oldPrice });
  assert(reverted.price === oldPrice, `reverted to ${oldPrice}`);

  section(`Result: ${failCount === 0 ? "ALL GREEN" : failCount + " FAILED"}`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
