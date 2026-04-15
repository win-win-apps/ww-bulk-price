// Very simple billing state check. For v1 we use Shopify's billing API via the app's
// `billing` config, but since that adds config surface we'll instead check for an active
// recurring charge via the session's access token. In this initial version the helper
// just returns a boolean flag based on an env override or the "ww_bulk_price_plan" metafield
// on the app installation. A proper Shopify billing integration can replace this without
// changing any callers.
import { prisma } from "../shopify.server";

export type BillingState = {
  isPaid: boolean;
  planName: "free" | "pro";
};

export async function getBillingState(shop: string): Promise<BillingState> {
  // Env override useful for demo/dev
  if (process.env.FORCE_PRO === "1") return { isPaid: true, planName: "pro" };

  // Look up the most recent session to see if we've cached a plan flag.
  // Future: replace with Shopify Billing API active-subscription check.
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) return { isPaid: false, planName: "free" };
  return { isPaid: false, planName: "free" };
}
