import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useSearchParams, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  DataTable,
  Button,
  Banner,
  Badge,
  InlineStack,
} from "@shopify/polaris";
import { authenticate, prisma } from "../shopify.server";
import { updateVariantsForProduct } from "../utils/shopify-queries.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const runs = await prisma.applyRun.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
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
  if (snap.undone) return json({ error: "Already undone." });

  const before: Array<{ variantId: string; productId: string; price: string; compareAtPrice: string | null }> =
    JSON.parse(snap.beforeJson);
  if (before.length === 0) return json({ error: "Snapshot is empty." });

  // Group by productId
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
  await prisma.applyRun.update({ where: { id: run.id }, data: { status: "undone" } });
  await prisma.applyRun.create({
    data: {
      shop: session.shop,
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

export default function HistoryPage() {
  const { runs } = useLoaderData<typeof loader>();
  const [sp] = useSearchParams();
  const ran = sp.get("ran");
  const undone = sp.get("undone");
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const rows = runs.map((r) => [
    new Date(r.createdAt).toLocaleString(),
    r.source,
    String(r.totalRows),
    String(r.successRows),
    String(r.failedRows),
    <StatusBadge key={`s-${r.id}`} status={r.status} />,
    r.source !== "undo" && r.snapshotId && r.status !== "undone" ? (
      <Form method="post" key={`u-${r.id}`}>
        <input type="hidden" name="runId" value={r.id} />
        <Button submit size="slim" loading={busy}>Undo</Button>
      </Form>
    ) : (
      ""
    ),
  ]);

  return (
    <Page title="History" backAction={{ url: "/app" }}>
      <BlockStack gap="400">
        {ran && <Banner tone="success" title="Changes applied" />}
        {undone && <Banner tone="success" title="Changes reverted" />}
        {actionData?.error && <Banner tone="critical" title={actionData.error} />}
        <Card>
          {runs.length === 0 ? (
            <Text as="p" tone="subdued">No runs yet.</Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "text", "text"]}
              headings={["When", "Source", "Total", "OK", "Failed", "Status", ""]}
              rows={rows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge tone="success">completed</Badge>;
  if (status === "failed") return <Badge tone="critical">failed</Badge>;
  if (status === "undone") return <Badge tone="info">undone</Badge>;
  return <Badge>{status}</Badge>;
}
