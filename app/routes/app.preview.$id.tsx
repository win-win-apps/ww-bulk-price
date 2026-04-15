import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  DataTable,
  Badge,
  InlineStack,
} from "@shopify/polaris";
import { authenticate, prisma } from "../shopify.server";
import { getStagedDiffs, clearStagedDiffs } from "../utils/staging.server";
import { applyDiffs, writeSnapshot } from "../utils/apply.server";
import { MAX_VARIANTS_PER_APPLY } from "../utils/constants";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing staging id", { status: 400 });
  const staged = getStagedDiffs(id, session.shop);
  if (!staged) {
    return json({
      expired: true as const,
      id,
      diffs: [] as typeof staged extends null ? never[] : never[],
      fileName: "",
      source: "csv" as const,
      overLimit: false,
      maxPerApply: MAX_VARIANTS_PER_APPLY,
    });
  }
  const overLimit = staged.diffs.length > MAX_VARIANTS_PER_APPLY;
  return json({
    expired: false as const,
    id,
    diffs: staged.diffs,
    fileName: staged.fileName,
    source: staged.source,
    overLimit,
    maxPerApply: MAX_VARIANTS_PER_APPLY,
  });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id!;
  const staged = getStagedDiffs(id, session.shop);
  if (!staged) return json({ error: "This preview expired. Please re-upload your CSV or run the quick adjust again." }, { status: 400 });

  if (staged.diffs.length > MAX_VARIANTS_PER_APPLY) {
    return json({ error: `This run would touch ${staged.diffs.length} variants. Maximum per run is ${MAX_VARIANTS_PER_APPLY}. Split your CSV and try again.` });
  }

  const label = `${staged.source === "csv" ? "CSV apply" : "Quick adjust"} ${new Date().toLocaleString()}`;
  const snapshot = await writeSnapshot(
    session.shop,
    label,
    staged.diffs,
    new Map(staged.currentByVariant)
  );
  const run = await prisma.applyRun.create({
    data: {
      shop: session.shop,
      status: "running",
      totalRows: staged.diffs.length,
      source: staged.source,
      snapshotId: snapshot.id,
    },
  });

  const result = await applyDiffs(admin, staged.diffs);

  // Status: completed = every row ok. partial = some ok + some failed. failed = nothing ok.
  const finalStatus =
    result.failed === 0
      ? "completed"
      : result.success === 0
      ? "failed"
      : "partial";
  await prisma.applyRun.update({
    where: { id: run.id },
    data: {
      status: finalStatus,
      successRows: result.success,
      failedRows: result.failed,
      errors: result.errors.length > 0 ? JSON.stringify(result.errors.slice(0, 100)) : null,
      completedAt: new Date(),
    },
  });

  clearStagedDiffs(id);
  return redirect(`/app/history?ran=${run.id}`);
};

export default function PreviewPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const nav = useNavigation();
  const applying = nav.state !== "idle";

  if ("expired" in data && data.expired) {
    return (
      <Page title="Preview not found" backAction={{ url: "/app" }}>
        <BlockStack gap="400">
          <Banner tone="warning" title="This preview expired">
            <Text as="p">
              Previews are held in memory for 30 minutes. Nothing was written to your store. Head
              back to Upload CSV or Quick adjust to start again.
            </Text>
          </Banner>
          <InlineStack gap="200">
            <Button url="/app/upload" variant="primary">Back to upload CSV</Button>
            <Button url="/app/adjust">Back to quick adjust</Button>
          </InlineStack>
        </BlockStack>
      </Page>
    );
  }

  const diffs = data.diffs as Array<any>;
  const changed = diffs.length;
  const flagged = diffs.filter((d) => d.flags.length > 0).length;

  const rows: Array<Array<React.ReactNode>> = diffs.slice(0, 500).map((d) => {
    const beforeCompare = d.before.compareAtPrice ? ` (compare at ${d.before.compareAtPrice})` : "";
    const afterCompare = d.after.compareAtPrice
      ? ` (compare at ${d.after.compareAtPrice})`
      : d.before.compareAtPrice
      ? " (compare at cleared)"
      : "";
    const before = `${d.before.price}${beforeCompare}`;
    const after = `${d.after.price}${afterCompare}`;
    const pct = d.pctChange == null ? "-" : `${d.pctChange > 0 ? "+" : ""}${d.pctChange.toFixed(1)}%`;
    const flag: React.ReactNode = d.flags.includes("big_drop") ? (
      <Badge tone="critical">big drop</Badge>
    ) : d.flags.includes("big_increase") ? (
      <Badge tone="warning">big increase</Badge>
    ) : (
      ""
    );
    return [d.productTitle || "-", d.variantTitle || "-", before, after, pct, flag];
  });

  const backUrl = data.source === "adjustment" ? "/app/adjust" : "/app/upload";
  return (
    <Page
      title={`Preview: ${changed} change${changed === 1 ? "" : "s"}`}
      subtitle={`${data.fileName || data.source}`}
      backAction={{ url: backUrl }}
    >
      <BlockStack gap="400">
        {data.overLimit && (
          <Banner tone="warning" title={`Over the per-run limit (${data.maxPerApply})`}>
            <Text as="p">
              This run would touch {diffs.length} variants. To keep things safe we cap any single
              apply at {data.maxPerApply}. Split your CSV into smaller chunks and come back.
            </Text>
          </Banner>
        )}
        {actionData?.error && <Banner tone="critical" title={actionData.error} />}

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="400">
              <Text as="span" variant="headingMd">
                {changed} change{changed === 1 ? "" : "s"}
              </Text>
              {flagged > 0 && (
                <Badge tone="warning">{`${flagged} flagged`}</Badge>
              )}
            </InlineStack>

            <DataTable
              columnContentTypes={["text", "text", "text", "text", "numeric", "text"]}
              headings={["Product", "Variant", "Before", "After", "Change", "Flag"]}
              rows={rows}
              truncate
            />
            {diffs.length > 500 && (
              <Text as="p" tone="subdued" variant="bodySm">
                Showing first 500 rows. All {diffs.length} changes will be applied.
              </Text>
            )}

            <Form method="post">
              <InlineStack gap="300">
                <Button submit variant="primary" loading={applying} disabled={data.overLimit}>
                  {`Apply ${changed} change${changed === 1 ? "" : "s"}`}
                </Button>
                <Button url={backUrl}>Cancel</Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
