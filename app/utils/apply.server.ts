import { updateVariantsForProduct, type VariantRow } from "./shopify-queries.server";
import type { DiffRow } from "./csv.server";
import { prisma } from "../shopify.server";
import { BATCH_SIZE, MAX_PARALLEL_BATCHES } from "./constants";

type GraphQLFn = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
type AdminLike = { graphql: GraphQLFn };

export async function writeSnapshot(shop: string, label: string, diffs: DiffRow[], currentByVariant: Map<string, VariantRow>) {
  const before = diffs
    .map((d) => {
      const cur = currentByVariant.get(d.variantId);
      if (!cur) return null;
      return {
        variantId: d.variantId,
        productId: cur.productId,
        price: cur.price,
        compareAtPrice: cur.compareAtPrice,
      };
    })
    .filter(Boolean);
  return prisma.priceSnapshot.create({
    data: {
      shop,
      label,
      rowCount: before.length,
      beforeJson: JSON.stringify(before),
    },
  });
}

async function runInParallel<T>(items: T[], concurrency: number, worker: (x: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

export type ApplyResult = {
  success: number;
  failed: number;
  errors: Array<{ variantId: string; message: string }>;
};

export async function applyDiffs(
  admin: AdminLike,
  diffs: DiffRow[],
  onProgress?: (done: number, total: number) => void
): Promise<ApplyResult> {
  // Group by productId because productVariantsBulkUpdate takes a productId
  const byProduct = new Map<string, DiffRow[]>();
  for (const d of diffs) {
    if (!d.productId) continue;
    const arr = byProduct.get(d.productId) || [];
    arr.push(d);
    byProduct.set(d.productId, arr);
  }

  // Build one or more batches per product when a product has more variants than BATCH_SIZE
  const batches: Array<{ productId: string; diffs: DiffRow[] }> = [];
  for (const [productId, arr] of byProduct.entries()) {
    for (let i = 0; i < arr.length; i += BATCH_SIZE) {
      batches.push({ productId, diffs: arr.slice(i, i + BATCH_SIZE) });
    }
  }

  const total = diffs.length;
  let done = 0;
  const result: ApplyResult = { success: 0, failed: 0, errors: [] };

  await runInParallel(batches, MAX_PARALLEL_BATCHES, async (batch) => {
    try {
      const variants = batch.diffs.map((d) => ({
        id: d.variantId,
        price: d.priceChanged ? d.after.price : undefined,
        compareAtPrice: d.compareChanged ? d.after.compareAtPrice : undefined,
      }));
      const res = await updateVariantsForProduct(admin, batch.productId, variants);
      result.success += res.succeeded.length;
      result.failed += res.failed.length;
      for (const f of res.failed) result.errors.push(f);
    } catch (err) {
      for (const d of batch.diffs) {
        result.failed += 1;
        result.errors.push({ variantId: d.variantId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      done += batch.diffs.length;
      if (onProgress) onProgress(done, total);
    }
  });

  return result;
}
