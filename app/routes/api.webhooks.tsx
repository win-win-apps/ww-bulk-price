// The Shopify CLI sends a preflight APP_UNINSTALLED test webhook to /api/webhooks
// on `shopify app dev` startup. The modern Remix template uses per-topic routes
// (webhooks.app.uninstalled.tsx etc), so /api/webhooks otherwise 404s and
// clutters the dev log. This no-op handler absorbs the preflight cleanly.
// Production webhook delivery uses the per-topic URIs declared in shopify.app.toml.
import type { ActionFunctionArgs } from "@remix-run/node";

export const action = async (_: ActionFunctionArgs) => {
  return new Response(null, { status: 200 });
};
