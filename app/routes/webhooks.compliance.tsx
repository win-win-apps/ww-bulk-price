import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, prisma } from "../shopify.server";

/**
 * GDPR compliance webhooks.
 *
 * Shopify sends all three mandatory compliance topics to a single endpoint
 * (declared as `compliance_topics` + `uri` in shopify.app.toml). This route
 * verifies the HMAC via `authenticate.webhook` and branches on the topic
 * field returned by the library.
 *
 * Topics handled here:
 *   - customers/data_request   Customer requests a copy of their data.
 *   - customers/redact         Shopify requests customer data erasure
 *                              (sent 48 hours after a store operator flags
 *                              a customer for deletion).
 *   - shop/redact              Shop uninstalled the app 48 hours ago and
 *                              all shop-level data must be erased.
 *
 * Bulk Price: CSV Editor does not store customer-level personal data. We
 * only store shop sessions, price snapshots (variant prices before an
 * apply run), and apply run history. So for customer topics we simply
 * acknowledge. For shop/redact we delete everything tied to the shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[compliance] ${topic} for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // No customer data stored. Nothing to return.
      break;

    case "CUSTOMERS_REDACT":
      // No customer data stored. Nothing to erase.
      break;

    case "SHOP_REDACT":
      // Erase all shop data.
      await prisma.priceSnapshot.deleteMany({ where: { shop } }).catch((e) => {
        console.error("shop/redact priceSnapshot deleteMany failed:", e);
      });
      await prisma.applyRun.deleteMany({ where: { shop } }).catch((e) => {
        console.error("shop/redact applyRun deleteMany failed:", e);
      });
      await prisma.session.deleteMany({ where: { shop } }).catch((e) => {
        console.error("shop/redact session deleteMany failed:", e);
      });
      break;

    default:
      console.warn(`[compliance] unknown topic received: ${topic}`);
      break;
  }

  return new Response();
};
