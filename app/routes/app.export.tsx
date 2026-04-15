import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fetchAllVariants } from "../utils/shopify-queries.server";
import { serializeCsv, variantsToCsvRows } from "../utils/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const variants = await fetchAllVariants(admin);
  const csv = serializeCsv(variantsToCsvRows(variants));
  const date = new Date().toISOString().slice(0, 10);
  const shopSlug = session.shop.replace(/\..*$/, "");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="prices-${shopSlug}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
