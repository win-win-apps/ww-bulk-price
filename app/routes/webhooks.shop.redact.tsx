import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, prisma } from "../shopify.server";

// GDPR: shop/redact — clean up all app data for the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — redacting all shop data`);

  await prisma.priceSnapshot.deleteMany({ where: { shop } });
  await prisma.applyRun.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });

  return new Response();
};
