import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, prisma } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  // Keep prior apply history in case merchant reinstalls.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
