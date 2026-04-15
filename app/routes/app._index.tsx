import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate, prisma } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const recent = await prisma.applyRun.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return json({ shop, recent });
};

export default function Dashboard() {
  const { recent } = useLoaderData<typeof loader>();

  return (
    <Page title="Bulk Price: CSV Editor" subtitle="Edit thousands of prices in minutes, with a preview and a 30 day undo">
      <BlockStack gap="500">
        <Banner tone="info" title="Two ways to edit, one safety net">
          <Text as="p" variant="bodyMd">
            Export a CSV and edit in Excel or Sheets, or skip the CSV and apply a percentage or fixed
            amount to everything at once. Every run previews first and saves a snapshot so you can
            undo within 30 days. Free, no per-run fees, no seat limits.
          </Text>
        </Banner>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              1. Export your current prices
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Download a CSV with every variant, current price, and compare-at price. Edit only the
              "new_*" columns in Excel or Google Sheets, then come back to upload.
            </Text>
            <InlineStack gap="200">
              <Link to="/app/export">
                <Button variant="primary">Download CSV</Button>
              </Link>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              2. Upload your edited CSV
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              We'll compare it against your live prices and show every single change before writing
              anything. Flagged rows surface big drops and typos so nothing surprises you.
            </Text>
            <InlineStack gap="200">
              <Link to="/app/upload">
                <Button>Upload CSV</Button>
              </Link>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Shortcut: quick adjust without a CSV
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Running a 15% sale? bumping everything by $2? Pick a percentage or fixed amount and
              optionally round to .99 or .95 charm endings. Still previews before writing, still
              undoable.
            </Text>
            <InlineStack gap="200">
              <Link to="/app/adjust">
                <Button>Quick adjust</Button>
              </Link>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Recent runs</Text>
            {recent.length === 0 ? (
              <Text as="p" tone="subdued" variant="bodyMd">
                No runs yet. Your apply history will show up here.
              </Text>
            ) : (
              <BlockStack gap="200">
                {recent.map((r) => (
                  <Box key={r.id}>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        {new Date(r.createdAt).toLocaleString()} &middot; {r.source} &middot; {r.successRows}/{r.totalRows} ok
                        {r.failedRows > 0 ? `, ${r.failedRows} failed` : ""}
                      </Text>
                      <Text as="span" variant="bodyMd" tone={r.status === "completed" ? "success" : r.status === "failed" ? "critical" : "subdued"}>
                        {r.status}
                      </Text>
                    </InlineStack>
                    <Divider />
                  </Box>
                ))}
                <Link to="/app/history">
                  <Button variant="plain">See full history</Button>
                </Link>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
