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
    <Page title="Bulk Price Editor" subtitle="Edit product prices in bulk via CSV">
      <BlockStack gap="500">
        <Banner tone="info" title="How it works">
          <Text as="p" variant="bodyMd">
            Export your products to a CSV, edit prices in Excel or Google Sheets, then upload to preview and apply.
            Every apply saves a snapshot so you can undo within 30 days.
          </Text>
        </Banner>

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              1. export your current prices
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Download a CSV with every variant, current price, compare-at price and cost. Edit only the "new_*"
              columns, then come back to upload.
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
              2. upload edited CSV
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Upload a CSV and we'll show you every change before anything is written to your store.
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
              Or do a quick adjustment
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Skip the CSV entirely and apply a percentage or fixed amount change to all products, with optional
              price rounding rules.
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
