import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useSearchParams, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Badge,
  Box,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import { authenticate, prisma } from "../shopify.server";
import { updateVariantsForProduct } from "../utils/shopify-queries.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const runs = await prisma.applyRun.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return json({ runs });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.formData();
  const runId = String(body.get("runId") || "");
  if (!runId) return json({ error: "Missing run id." });
  const run = await prisma.applyRun.findFirst({ where: { id: runId, shop: session.shop } });
  if (!run) return json({ error: "Run not found." });
  if (!run.snapshotId) return json({ error: "No snapshot available for this run." });
  const snap = await prisma.priceSnapshot.findFirst({ where: { id: run.snapshotId, shop: session.shop } });
  if (!snap) return json({ error: "Snapshot missing." });
  if (snap.undone) return json({ error: "This run has already been reverted." });

  const before: Array<{ variantId: string; productId: string; price: string; compareAtPrice: string | null }> =
    JSON.parse(snap.beforeJson);
  if (before.length === 0) return json({ error: "Snapshot is empty." });

  // Group by productId — productVariantsBulkUpdate is one call per product.
  const byProduct = new Map<string, Array<(typeof before)[number]>>();
  for (const b of before) {
    const arr = byProduct.get(b.productId) || [];
    arr.push(b);
    byProduct.set(b.productId, arr);
  }

  let ok = 0;
  let failed = 0;
  const errs: Array<{ variantId: string; message: string }> = [];
  for (const [productId, arr] of byProduct.entries()) {
    try {
      const res = await updateVariantsForProduct(
        admin,
        productId,
        arr.map((b) => ({ id: b.variantId, price: b.price, compareAtPrice: b.compareAtPrice }))
      );
      ok += res.succeeded.length;
      failed += res.failed.length;
      for (const f of res.failed) errs.push(f);
    } catch (e) {
      failed += arr.length;
      for (const b of arr) errs.push({ variantId: b.variantId, message: e instanceof Error ? e.message : String(e) });
    }
  }

  await prisma.priceSnapshot.update({ where: { id: snap.id }, data: { undone: true } });
  await prisma.applyRun.update({ where: { id: run.id }, data: { status: "reverted" } });
  await prisma.applyRun.create({
    data: {
      shop: session.shop,
      title: `Reverted: ${run.title || "Untitled run"}`,
      description: `Restored prices of ${before.length} variant${before.length === 1 ? "" : "s"} to the state before the original run`,
      status: failed === 0 ? "completed" : "failed",
      totalRows: before.length,
      successRows: ok,
      failedRows: failed,
      errors: errs.length > 0 ? JSON.stringify(errs.slice(0, 100)) : null,
      source: "undo",
      snapshotId: null,
      completedAt: new Date(),
    },
  });
  return redirect(`/app/history?undone=${run.id}`);
};

function formatDateTime(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  const sameDay =
    dt.getFullYear() === now.getFullYear() &&
    dt.getMonth() === now.getMonth() &&
    dt.getDate() === now.getDate();
  if (sameDay) {
    return `Today, ${dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    dt.getFullYear() === yesterday.getFullYear() &&
    dt.getMonth() === yesterday.getMonth() &&
    dt.getDate() === yesterday.getDate()
  ) {
    return `Yesterday, ${dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return dt.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusBadge(status: string) {
  if (status === "completed") return <Badge tone="success">Complete</Badge>;
  if (status === "partial") return <Badge tone="warning">Partial</Badge>;
  if (status === "failed") return <Badge tone="critical">Failed</Badge>;
  if (status === "reverted") return <Badge tone="info">Reverted</Badge>;
  if (status === "undone") return <Badge tone="info">Reverted</Badge>;
  if (status === "running") return <Badge tone="attention">Running</Badge>;
  return <Badge>{status}</Badge>;
}

export default function HistoryPage() {
  const { runs } = useLoaderData<typeof loader>();
  const [sp] = useSearchParams();
  const ran = sp.get("ran");
  const undone = sp.get("undone");
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <Page
      title="Price change jobs"
      subtitle="Every CSV upload, quick adjust, sale, and undo from the last 30 days. Click Revert on any row to roll that run back."
      backAction={{ url: "/app" }}
      primaryAction={{ content: "Create new price change job", url: "/app/adjust" }}
    >
      <BlockStack gap="400">
        {ran && <Banner tone="success" title="Changes applied" />}
        {undone && <Banner tone="success" title="Run reverted" />}
        {actionData?.error && <Banner tone="critical" title={actionData.error} />}

        <Card padding="0">
          {runs.length === 0 ? (
            <Box padding="800">
              <EmptyState
                heading="No price change jobs yet"
                action={{ content: "Upload CSV", url: "/app/upload" }}
                secondaryAction={{ content: "Quick adjust", url: "/app/adjust" }}
                image=""
              >
                <Text as="p">
                  Once you apply a CSV or a quick adjust, every run shows up here with a one click
                  revert button. Snapshots are kept for 30 days.
                </Text>
              </EmptyState>
            </Box>
          ) : (
            <BlockStack gap="0">
              {runs.map((r, idx) => {
                const canRevert =
                  r.source !== "undo" &&
                  r.snapshotId != null &&
                  r.status !== "reverted" &&
                  r.status !== "undone" &&
                  r.status !== "running";
                const title = r.title || (r.source === "csv" ? "CSV upload" : r.source === "sale" ? "Sale" : r.source === "undo" ? "Revert" : "Quick adjust");
                const description = r.description || `${r.successRows}/${r.totalRows} variants updated${r.failedRows > 0 ? `, ${r.failedRows} failed` : ""}`;
                return (
                  <Box key={r.id}>
                    <Box paddingInline="500" paddingBlock="400">
                      <InlineStack align="space-between" blockAlign="start" wrap={false} gap="400">
                        <Box minWidth="0">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm" breakWord>{title}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {formatDateTime(r.createdAt)}
                              {r.source && r.source !== "undo" ? ` · ${r.source === "csv" ? "CSV" : r.source === "sale" ? "Sale" : "Quick adjust"}` : ""}
                            </Text>
                            <Text as="p" variant="bodyMd">{description}</Text>
                          </BlockStack>
                        </Box>
                        <BlockStack gap="200" align="end">
                          <InlineStack gap="200" blockAlign="center">
                            {statusBadge(r.status)}
                          </InlineStack>
                          {canRevert && (
                            <Form method="post">
                              <input type="hidden" name="runId" value={r.id} />
                              <Button submit size="slim" loading={busy}>
                                Revert
                              </Button>
                            </Form>
                          )}
                        </BlockStack>
                      </InlineStack>
                    </Box>
                    {idx < runs.length - 1 && <Divider />}
                  </Box>
                );
              })}
            </BlockStack>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
