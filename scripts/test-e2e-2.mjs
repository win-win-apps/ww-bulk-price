// Part 2: adjustment diffs, multi-product apply, snapshot + undo roundtrip
import Papa from "papaparse";

const SHOP = "win-win-ccae-dev.myshopify.com";
const TOKEN = process.env.WWBP_TOKEN;
if (!TOKEN) { console.error("Set WWBP_TOKEN"); process.exit(2); }
const API = `https://${SHOP}/admin/api/2025-01/graphql.json`;

let failCount = 0;
function assert(c, l) { if (c) console.log("  ok   " + l); else { console.log("  FAIL " + l); failCount++; } }
function section(n) { console.log("\n== " + n + " =="); }

async function gql(q, v) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query: q, variables: v }),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const b = await r.json();
  if (b.errors) throw new Error("GQL: " + JSON.stringify(b.errors));
  return b.data;
}

async function fetchAllVariants() {
  const out = [];
  let cursor = null;
  while (true) {
    const d = await gql(`query Q($cursor: String) {
      productVariants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id title price compareAtPrice product { id title handle } }
      }
    }`, { cursor });
    for (const n of d.productVariants.nodes) {
      out.push({
        variantId: n.id, variantTitle: n.title, price: n.price, compareAtPrice: n.compareAtPrice,
        productId: n.product.id, productTitle: n.product.title, productHandle: n.product.handle,
      });
    }
    if (!d.productVariants.pageInfo.hasNextPage) break;
    cursor = d.productVariants.pageInfo.endCursor;
  }
  return out;
}

async function bulkUpdate(productId, variants) {
  const d = await gql(`mutation M($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message }
    }
  }`, { productId, variants });
  const e = d.productVariantsBulkUpdate.userErrors;
  if (e && e.length > 0) throw new Error("upd: " + JSON.stringify(e));
  return d.productVariantsBulkUpdate.productVariants;
}

// ---- adjustment logic (copy) ----
function roundToEnding(v, ending) {
  const whole = Math.floor(v);
  const low = Math.max(0, whole - 1) + ending;
  const high = whole + ending;
  return Math.abs(v - high) <= Math.abs(v - low) ? high : low;
}
function applyRounding(v, r) {
  if (r === "end_99") return Math.max(0, roundToEnding(v, 0.99));
  if (r === "end_95") return Math.max(0, roundToEnding(v, 0.95));
  if (r === "end_00") return Math.max(0, Math.round(v));
  return Math.max(0, Math.round(v * 100) / 100);
}
function buildAdjustmentDiffs(input, variants) {
  const diffs = [];
  for (const v of variants) {
    const f = input.field;
    const cur = f === "price" ? v.price : v.compareAtPrice;
    if (cur == null || cur === "") continue;
    const n = Number(cur);
    if (Number.isNaN(n)) continue;
    let newN = input.mode === "percent" ? n * (1 + input.amount / 100) : n + input.amount;
    newN = applyRounding(newN, input.rounding);
    if (newN < 0) newN = 0;
    const priceChanged = f === "price" && newN.toFixed(2) !== Number(v.price).toFixed(2);
    const compareChanged = f === "compare_at_price" && (v.compareAtPrice == null ? true : newN.toFixed(2) !== Number(v.compareAtPrice).toFixed(2));
    if (!priceChanged && !compareChanged) continue;
    diffs.push({
      variantId: v.variantId, productId: v.productId,
      before: { price: v.price, compareAtPrice: v.compareAtPrice },
      after: { price: f === "price" ? newN.toFixed(2) : v.price, compareAtPrice: f === "compare_at_price" ? newN.toFixed(2) : v.compareAtPrice },
      priceChanged, compareChanged,
    });
  }
  return diffs;
}

// ---- snapshot simulation ----
function makeSnapshot(diffs, currentByVariant) {
  return diffs.map((d) => {
    const cur = currentByVariant.get(d.variantId);
    return { variantId: d.variantId, productId: cur.productId, price: cur.price, compareAtPrice: cur.compareAtPrice };
  });
}

(async () => {
  section("Fetch variants");
  const variants = await fetchAllVariants();
  assert(variants.length > 0, `got ${variants.length}`);
  const prodIds = new Set(variants.map((v) => v.productId));
  assert(prodIds.size >= 2, `>= 2 products (got ${prodIds.size})`);

  section("buildAdjustmentDiffs +10% to all price (rounding=none)");
  const d1 = buildAdjustmentDiffs(
    { scope: "all", field: "price", mode: "percent", amount: 10, rounding: "none" },
    variants
  );
  assert(d1.length > 0, `produced ${d1.length} diffs`);
  // Spot check one
  const s1 = d1[0];
  const orig = variants.find((v) => v.variantId === s1.variantId);
  const expect = (Number(orig.price) * 1.1).toFixed(2);
  assert(s1.after.price === expect, `first diff: ${orig.price} -> ${s1.after.price} expected ${expect}`);

  section("buildAdjustmentDiffs +10% end_99 rounding");
  const d2 = buildAdjustmentDiffs(
    { scope: "all", field: "price", mode: "percent", amount: 10, rounding: "end_99" },
    variants
  );
  assert(d2.length > 0, `produced ${d2.length} diffs`);
  assert(d2.every((d) => d.after.price.endsWith(".99") || Number(d.after.price) === 0), "all ending in .99 (or zero)");

  section("LIVE: apply diff across 2 products, snapshot, verify, undo");
  // Pick 2 variants from DIFFERENT products
  const byProd = new Map();
  for (const v of variants) {
    if (!byProd.has(v.productId)) byProd.set(v.productId, v);
    if (byProd.size >= 2) break;
  }
  const picks = Array.from(byProd.values());
  assert(picks.length === 2, `picked 2 variants from 2 different products`);
  console.log(`  pick A: ${picks[0].productTitle} ${picks[0].variantTitle} price=${picks[0].price}`);
  console.log(`  pick B: ${picks[1].productTitle} ${picks[1].variantTitle} price=${picks[1].price}`);

  // Construct diffs: bump each by $0.02
  const testDiffs = picks.map((v) => ({
    variantId: v.variantId,
    productId: v.productId,
    before: { price: v.price, compareAtPrice: v.compareAtPrice },
    after: { price: (Number(v.price) + 0.02).toFixed(2), compareAtPrice: v.compareAtPrice },
    priceChanged: true,
    compareChanged: false,
  }));

  // Snapshot the befores
  const currentByVariant = new Map(variants.map((v) => [v.variantId, v]));
  const snapshot = makeSnapshot(testDiffs, currentByVariant);
  assert(snapshot.length === 2, "snapshot has 2 entries");
  assert(snapshot[0].price === picks[0].price, "snapshot preserves original A price");
  assert(snapshot[1].price === picks[1].price, "snapshot preserves original B price");

  // Apply per product (simulating applyDiffs)
  const byProduct = new Map();
  for (const d of testDiffs) {
    const arr = byProduct.get(d.productId) || [];
    arr.push(d);
    byProduct.set(d.productId, arr);
  }
  for (const [pid, arr] of byProduct.entries()) {
    await bulkUpdate(pid, arr.map((d) => ({ id: d.variantId, price: d.after.price })));
  }

  // Verify via refetch
  const post = await fetchAllVariants();
  const postA = post.find((v) => v.variantId === picks[0].variantId);
  const postB = post.find((v) => v.variantId === picks[1].variantId);
  assert(postA.price === testDiffs[0].after.price, `A now ${postA.price}`);
  assert(postB.price === testDiffs[1].after.price, `B now ${postB.price}`);

  // Undo: read snapshot, group by productId, bulk-update back
  const snapByProduct = new Map();
  for (const s of snapshot) {
    const arr = snapByProduct.get(s.productId) || [];
    arr.push(s);
    snapByProduct.set(s.productId, arr);
  }
  for (const [pid, arr] of snapByProduct.entries()) {
    await bulkUpdate(pid, arr.map((s) => ({ id: s.variantId, price: s.price, compareAtPrice: s.compareAtPrice })));
  }

  // Verify undo
  const post2 = await fetchAllVariants();
  const post2A = post2.find((v) => v.variantId === picks[0].variantId);
  const post2B = post2.find((v) => v.variantId === picks[1].variantId);
  assert(post2A.price === picks[0].price, `A reverted to ${post2A.price}`);
  assert(post2B.price === picks[1].price, `B reverted to ${post2B.price}`);

  section("LIVE: compare_at clear via api then restore");
  const withCompare = variants.find((v) => v.compareAtPrice && Number(v.compareAtPrice) > 0);
  if (!withCompare) {
    console.log("  skip — no variant has compare_at on this store, creating one");
    // set compare_at on first variant, then test clearing it, then clear it
    const target = variants[0];
    const setCompare = (Number(target.price) + 100).toFixed(2);
    await bulkUpdate(target.productId, [{ id: target.variantId, compareAtPrice: setCompare }]);
    // now clear
    await bulkUpdate(target.productId, [{ id: target.variantId, compareAtPrice: null }]);
    const post3 = await fetchAllVariants();
    const post3t = post3.find((v) => v.variantId === target.variantId);
    assert(post3t.compareAtPrice === null, `compare_at cleared to ${post3t.compareAtPrice}`);
  } else {
    const orig = withCompare.compareAtPrice;
    await bulkUpdate(withCompare.productId, [{ id: withCompare.variantId, compareAtPrice: null }]);
    const post3 = await fetchAllVariants();
    const post3t = post3.find((v) => v.variantId === withCompare.variantId);
    assert(post3t.compareAtPrice === null, `compare_at cleared`);
    // restore
    await bulkUpdate(withCompare.productId, [{ id: withCompare.variantId, compareAtPrice: orig }]);
    const post4 = await fetchAllVariants();
    const post4t = post4.find((v) => v.variantId === withCompare.variantId);
    assert(post4t.compareAtPrice === orig, `compare_at restored to ${orig}`);
  }

  section(`Result: ${failCount === 0 ? "ALL GREEN" : failCount + " FAILED"}`);
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
