import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export async function loader({ request }: LoaderFunctionArgs) {
  // Preserve all Shopify query params (shop, session, hmac, etc.)
  // so authenticate.admin() can identify the shop and complete token exchange
  const url = new URL(request.url);
  return redirect(`/app${url.search}`);
}

export default function IndexRedirect() {
  return null;
}
