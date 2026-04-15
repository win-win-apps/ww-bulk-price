import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR: customers/redact
 *
 * Shopify sends this 48 hours after a customer requests erasure. Product
 * Badges stores no customer-level data, so there is nothing to redact.
 * We verify the HMAC and acknowledge the request.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — no customer data to redact`);
  return new Response();
};
