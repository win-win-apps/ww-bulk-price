// In-memory per-shop staging for the "upload CSV -> preview -> apply" flow.
// This trades a bit of memory for zero extra DB models. Entries auto-expire.
import type { DiffRow } from "./csv.server";
import type { VariantRow } from "./shopify-queries.server";

type StagedBatch = {
  id: string;
  shop: string;
  createdAt: number;
  diffs: DiffRow[];
  fileName: string;
  source: "csv" | "adjustment";
  // Snapshot of current variants at preview time, used to write the undo snapshot at apply time
  currentByVariant: Array<[string, VariantRow]>;
};

const STORE = new Map<string, StagedBatch>();
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function gc() {
  const now = Date.now();
  for (const [k, v] of STORE.entries()) {
    if (now - v.createdAt > TTL_MS) STORE.delete(k);
  }
}

export function stageDiffs(opts: {
  shop: string;
  diffs: DiffRow[];
  fileName: string;
  source: "csv" | "adjustment";
  currentByVariant: Map<string, VariantRow>;
}): string {
  gc();
  const id = `stg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  STORE.set(id, {
    id,
    shop: opts.shop,
    createdAt: Date.now(),
    diffs: opts.diffs,
    fileName: opts.fileName,
    source: opts.source,
    currentByVariant: Array.from(opts.currentByVariant.entries()),
  });
  return id;
}

export function getStagedDiffs(id: string, shop: string): StagedBatch | null {
  gc();
  const entry = STORE.get(id);
  if (!entry || entry.shop !== shop) return null;
  return entry;
}

export function clearStagedDiffs(id: string) {
  STORE.delete(id);
}
