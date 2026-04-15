import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  InlineStack,
  DropZone,
  Box,
  Link as PolarisLink,
} from "@shopify/polaris";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import { fetchAllVariants } from "../utils/shopify-queries.server";
import { parseCsv, computeDiff } from "../utils/csv.server";
import { stageDiffs } from "../utils/staging.server";
import { MAX_VARIANTS_PER_APPLY } from "../utils/constants";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ maxPerApply: MAX_VARIANTS_PER_APPLY });
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

  // Build a helpful description from the diff. We compute average % change so
  // the history list can say "Lowers prices of 312 variants by ~10%".
  let avgPct = 0;
  let pctCount = 0;
  for (const d of diffs) {
    if (d.pctChange != null && !Number.isNaN(d.pctChange)) {
      avgPct += d.pctChange;
      pctCount++;
    }
  }
  const meanPct = pctCount > 0 ? avgPct / pctCount : null;
  const noun = diffs.length === 1 ? "variant" : "variants";
  let description: string;
  if (meanPct == null) {
    description = `CSV upload: ${diffs.length} ${noun} updated`;
  } else if (meanPct < -0.5) {
    description = `Lowers prices of ${diffs.length} ${noun} by ~${Math.abs(meanPct).toFixed(1)}% (CSV)`;
  } else if (meanPct > 0.5) {
    description = `Raises prices of ${diffs.length} ${noun} by ~${meanPct.toFixed(1)}% (CSV)`;
  } else {
    description = `Updates ${diffs.length} ${noun} via CSV`;
  }

  const stagingId = stageDiffs({
    shop: session.shop,
    diffs,
    fileName,
    source: "csv",
    title: `CSV: ${fileName}`,
    description,
    currentByVariant: currentMap,
  });

  return redirect(`/app/preview/${stagingId}`);
};

export default function UploadPage() {
  const { maxPerApply } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; parseErrors?: string[] } | undefined;
  const nav = useNavigation();
  const submit = useSubmit();
  const submitting = nav.state !== "idle";

  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[], rejectedFiles: File[]) => {
      setLocalError(null);
      if (rejectedFiles.length > 0) {
        setLocalError("That file is not a CSV. Please upload a .csv file.");
        return;
      }
      if (acceptedFiles.length > 0) {
        setFile(acceptedFiles[0]);
      }
    },
    []
  );

  const handleSubmit = useCallback(() => {
    if (!file) {
      setLocalError("Pick a CSV file first.");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    submit(fd, { method: "post", encType: "multipart/form-data" });
  }, [file, submit]);

  const fileUpload = !file && <DropZone.FileUpload actionTitle="Add a CSV" actionHint="or drop a .csv file to upload" />;
  const uploadedFile = file && (
    <Box padding="400">
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight="semibold">{file.name}</Text>
        <Text as="p" variant="bodySm" tone="subdued">{(file.size / 1024).toFixed(1)} KB</Text>
      </BlockStack>
    </Box>
  );

  return (
    <Page
      title="Upload your edited CSV"
      subtitle="We will diff it against your live prices and show every change before writing anything"
      backAction={{ url: "/app" }}
    >
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner tone="critical" title={actionData.error}>
            {actionData.parseErrors && actionData.parseErrors.length > 0 && (
              <BlockStack gap="100">
                {actionData.parseErrors.slice(0, 20).map((e, i) => (
                  <Text as="p" variant="bodySm" key={i}>{e}</Text>
                ))}
                {actionData.parseErrors.length > 20 && (
                  <Text as="p" variant="bodySm">...and {actionData.parseErrors.length - 20} more</Text>
                )}
              </BlockStack>
            )}
          </Banner>
        )}
        {localError && <Banner tone="critical" title={localError} />}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Drop in your CSV</Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Only rows where <Text as="span" fontWeight="semibold">new_price</Text> or{" "}
              <Text as="span" fontWeight="semibold">new_compare_at_price</Text> differ from what is live
              will be flagged as changes. Everything else is ignored, so partial edits are safe, and you
              can leave columns untouched if you only want to move some prices.
            </Text>
            <DropZone
              accept="text/csv,.csv"
              type="file"
              allowMultiple={false}
              onDrop={handleDrop}
            >
              {uploadedFile}
              {fileUpload}
            </DropZone>
            <InlineStack gap="200">
              <Button variant="primary" loading={submitting} onClick={handleSubmit} disabled={!file}>
                Preview changes
              </Button>
              {file && (
                <Button onClick={() => setFile(null)} disabled={submitting}>
                  Clear
                </Button>
              )}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Free, with a per-run safety ceiling of {maxPerApply.toLocaleString()} variants. Split
              larger jobs into chunks.
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
