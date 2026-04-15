import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
  Link as PolarisLink,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { fetchAllVariants } from "../utils/shopify-queries.server";
import { parseCsv, computeDiff } from "../utils/csv.server";
import { stageDiffs } from "../utils/staging.server";
import { FREE_PLAN_PRODUCT_CAP } from "../utils/constants";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ freeCap: FREE_PLAN_PRODUCT_CAP });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 10 * 1024 * 1024 });
  const form = await unstable_parseMultipartFormData(request, uploadHandler);
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return json({ error: "No file uploaded." }, { status: 400 });
  }
  const fileName = (file as File).name || "upload.csv";
  const text = await (file as File).text();
  const parsed = parseCsv(text);
  if (parsed.errors.length > 0 && parsed.rows.length === 0) {
    return json({ error: "Could not parse CSV", parseErrors: parsed.errors }, { status: 400 });
  }

  const currentVariants = await fetchAllVariants(admin);
  const currentMap = new Map(currentVariants.map((v) => [v.variantId, v]));

  const { diffs, errors } = computeDiff(parsed.rows, currentVariants);

  if (diffs.length === 0) {
    return json({
      error: "No changes detected in the uploaded CSV.",
      parseErrors: [...parsed.errors, ...errors],
    });
  }

  const stagingId = stageDiffs({
    shop: session.shop,
    diffs,
    fileName,
    source: "csv",
    currentByVariant: currentMap,
  });

  return redirect(`/app/preview/${stagingId}`);
};

export default function UploadPage() {
  const { freeCap } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; parseErrors?: string[] } | undefined;
  const nav = useNavigation();
  const submitting = nav.state !== "idle";

  return (
    <Page title="Upload price CSV" backAction={{ url: "/app" }}>
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner tone="critical" title={actionData.error}>
            {actionData.parseErrors && actionData.parseErrors.length > 0 && (
              <ul>
                {actionData.parseErrors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {actionData.parseErrors.length > 20 && <li>...and {actionData.parseErrors.length - 20} more</li>}
              </ul>
            )}
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Upload your edited CSV</Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Only rows where "new_price" or "new_compare_at_price" differ from the "current_*" values will be flagged as
              changes. Everything else is ignored.
            </Text>
            <Form method="post" encType="multipart/form-data">
              <input type="file" name="file" accept=".csv,text/csv" required />
              <div style={{ marginTop: 12 }}>
                <Button variant="primary" submit loading={submitting}>
                  Preview changes
                </Button>
              </div>
            </Form>
            <Text as="p" variant="bodySm" tone="subdued">
              Free plan: up to {freeCap} variants per apply. Upgrade to remove the limit.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Don't have a CSV yet? <PolarisLink url="/app/export">Download your current prices</PolarisLink>
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
