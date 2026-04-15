import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  InlineStack,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { fetchAllVariants } from "../utils/shopify-queries.server";
import { buildAdjustmentDiffs, type AdjustmentInput, type AdjustmentField, type AdjustmentMode, type RoundingRule } from "../utils/adjustments.server";
import { stageDiffs } from "../utils/staging.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.formData();
  const field = (body.get("field") as AdjustmentField) || "price";
  const mode = (body.get("mode") as AdjustmentMode) || "percent";
  const amountStr = String(body.get("amount") || "0");
  const amount = Number(amountStr);
  const rounding = (body.get("rounding") as RoundingRule) || "none";

  if (Number.isNaN(amount)) {
    return json({ error: "Amount must be a number." });
  }
  if (amount === 0) {
    return json({ error: "Amount cannot be zero." });
  }

  const variants = await fetchAllVariants(admin);
  const input: AdjustmentInput = { scope: "all", field, mode, amount, rounding };
  const diffs = buildAdjustmentDiffs(input, variants);

  if (diffs.length === 0) {
    return json({ error: "No variants matched this adjustment." });
  }

  const currentMap = new Map(variants.map((v) => [v.variantId, v]));
  const id = stageDiffs({
    shop: session.shop,
    diffs,
    fileName: `quick adjust ${mode} ${amount}`,
    source: "adjustment",
    currentByVariant: currentMap,
  });
  return redirect(`/app/preview/${id}`);
};

export default function AdjustPage() {
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const nav = useNavigation();
  const submitting = nav.state !== "idle";

  const [field, setField] = useState<AdjustmentField>("price");
  const [mode, setMode] = useState<AdjustmentMode>("percent");
  const [amount, setAmount] = useState<string>("10");
  const [rounding, setRounding] = useState<RoundingRule>("none");

  return (
    <Page
      title="Quick adjust"
      subtitle="Move every price by a percentage or fixed amount, no CSV required"
      backAction={{ url: "/app" }}
    >
      <BlockStack gap="400">
        {actionData?.error && <Banner tone="critical" title={actionData.error} />}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Adjust every variant at once</Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Great for flash sales, seasonal bumps, or rolling back a previous sale. Pick a percent or
              fixed amount, optionally snap to a charm ending, and you will see every single change in
              the preview before anything gets written to your store.
            </Text>

            <Form method="post">
              <BlockStack gap="300">
                <Select
                  label="Which field to change"
                  options={[
                    { label: "Regular price", value: "price" },
                    { label: "Compare-at price", value: "compare_at_price" },
                  ]}
                  value={field}
                  onChange={(v) => setField(v as AdjustmentField)}
                  name="field"
                />
                <Select
                  label="How to change it"
                  options={[
                    { label: "Percentage (+ or -)", value: "percent" },
                    { label: "Fixed amount (+ or -)", value: "fixed" },
                  ]}
                  value={mode}
                  onChange={(v) => setMode(v as AdjustmentMode)}
                  name="mode"
                />
                <TextField
                  label={mode === "percent" ? "Percent change (e.g. 10 = +10%, -5 = -5%)" : "Fixed amount (e.g. 2.50 or -2.50)"}
                  value={amount}
                  onChange={setAmount}
                  name="amount"
                  type="number"
                  step={0.01}
                  autoComplete="off"
                />
                <Select
                  label="Rounding rule"
                  helpText="Optional. Rounds each new price to the nearest ending you pick."
                  options={[
                    { label: "None (keep exact cents)", value: "none" },
                    { label: "End in .99 (charm pricing)", value: "end_99" },
                    { label: "End in .95", value: "end_95" },
                    { label: "Whole dollar", value: "end_00" },
                  ]}
                  value={rounding}
                  onChange={(v) => setRounding(v as RoundingRule)}
                  name="rounding"
                />
                <InlineStack gap="200">
                  <Button variant="primary" submit loading={submitting}>
                    Preview changes
                  </Button>
                  <Button url="/app">Cancel</Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
