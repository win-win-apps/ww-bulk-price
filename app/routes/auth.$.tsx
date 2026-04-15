import type { LoaderFunctionArgs } from "@remix-run/node";
import { login } from "../shopify.server";

// This splat route handles /auth/login and OAuth callbacks.
// Must use login(), not authenticate.admin() — the login path requires login().
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return login(request);
};
