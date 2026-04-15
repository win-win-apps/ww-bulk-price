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
import { FREE_PLAN_PRODUCT_CAP } from "../utils/constants";
import { getBillingState } from "../utils/billing.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing staging id", { status: 400 });
  const staged = getStagedDiffs(id, session.shop);
  const billing = await getBillingState(session.shop);
  if (!staged) {
    return json({
      expired: true as const,
      id,
      diffs: [] as typeof staged extends null ? never[] : never[],
      fileName: "",
      source: "csv" as const,
      overLimit: false,
      freeCap: FREE_PLAN_PRODUCT_CAP,
      isPaid: billing.isPaid,
    });
  }
  const overLimit = !billing.isPaid && staged.diffs.length > FREE_PLAN_PRODUCT_CAP;
  return json({
    expired: false as const,
    id,
    diffs: staged.diffs,
    fileName: staged.fileName,
    source: staged.source,
    overLimit,
    freeCap: FREE_PLAN_PRODUCT_CAP,
    isPaid: billing.isPaid,
  });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id!;
  const staged = getStagedDiffs(id, session.shop);
  if (!staged) return json({ error: "Session expired, re-upload your CSV." }, { status: 400 });

  const billing = await getBillingState(session.shop);
  if (!billing.isPaid && staged.diffs.length > FREE_PLAN_PRODUCT_CAP) {
    return json({ error: `Free plan allows ${FREE_PLAN_PRODUCT_CAP} variants per apply. Upgrade to remove the limit.` });
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

  await prisma.applyRun.update({
    where: { id: run.id },
    data: {
      status: result.failed === 0 ? "completed" : result.success === 0 ? "failed" : "completed",
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
      <Page title="Preview not found">
        <Banner tone="warning" title="Session expired">
          We could not find this upload. Please re-upload your CSV.
        </Banner>
      </Page>
    );
  }

  const diffs = data.diffs as Array<any>;
  const changed = diffs.length;
  const flagged = diffs.filter((d) => d.flags.length > 0).length;

  const rows: Array<Array<React.ReactNode>> = diffs.slice(0, 500).map((d) => {
    const before = `${d.before.price}${d.before.compareAtPrice ? ` (was ${d.before.compareAtPrice})` : ""}`;
    const after = `${d.after.price}${d.after.compareAtPrice ? ` (was ${d.after.compareAtPrice})` : ""}`;
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

  return (
    <Page
      title={`Preview: ${changed} change${changed === 1 ? "" : "s"}`}
      subtitle={`${data.fileName || data.source}`}
      backAction={{ url: "/app/upload" }}
    >
      <BlockStack gap="400">
        {data.overLimit && (
          <Banner tone="warning" title={`Over the free-plan limit (${data.freeCap})`}>
            <Text as="p">Upgrade to Pro to apply more than {data.freeCap} variants per run.</Text>
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
                <Button url="/app/upload">Cancel</Button>
              </InlineStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
