import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR: customers/data_request
 *
 * Shopify sends this when a customer requests their data. Product Badges
 * does not store any customer personal data — badges are configured by the
 * merchant and targeted at products/collections/tags, not at individual
 * customers. We acknowledge the webhook so Shopify records it as received,
 * but there is no customer data to return.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — no customer data stored`);
  return new Response();
};
