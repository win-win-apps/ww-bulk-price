// Query wrappers for the Shopify Admin GraphQL API
import { APIRateLimitError } from "./errors";
import { withRetry } from "./retry.server";

const THROTTLE_MESSAGE = "Throttled";

type GraphQLFn = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

async function runGraphql<T>(admin: { graphql: GraphQLFn }, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  if (!res.ok) throw new Error(`Shopify network error: ${res.status}`);
  const body: any = await res.json();
  if (body.errors) {
    const first = body.errors[0]?.message;
    if (first && first.toLowerCase().includes(THROTTLE_MESSAGE.toLowerCase())) {
      throw new APIRateLimitError(first, body.extensions?.cost);
    }
    throw new Error(`Shopify GraphQL error: ${first || JSON.stringify(body.errors)}`);
  }
  return body.data as T;
}

export type VariantRow = {
  productId: string;
  productTitle: string;
  productHandle: string;
  variantId: string;
  variantTitle: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  cost: string | null;
  inventoryItemId: string | null;
  currencyCode: string;
};

const PRODUCT_VARIANTS_PAGE_QUERY = `#graphql
  query productVariantsPage($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        price
        compareAtPrice
        product { id title handle }
        inventoryItem {
          id
          unitCost { amount }
        }
      }
    }
    shop { currencyCode }
  }
`;

export async function fetchAllVariants(admin: { graphql: GraphQLFn }): Promise<VariantRow[]> {
  const out: VariantRow[] = [];
  let cursor: string | null = null;
  let currencyCode = "USD";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await withRetry(() =>
      runGraphql<{
        productVariants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            id: string;
            title: string;
            sku: string | null;
            price: string;
            compareAtPrice: string | null;
            product: { id: string; title: string; handle: string };
            inventoryItem: { id: string; unitCost: { amount: string } | null } | null;
          }>;
        };
        shop: { currencyCode: string };
      }>(admin, PRODUCT_VARIANTS_PAGE_QUERY, { cursor })
    );
    currencyCode = data.shop.currencyCode;
    for (const n of data.productVariants.nodes) {
      out.push({
        productId: n.product.id,
        productTitle: n.product.title,
        productHandle: n.product.handle,
        variantId: n.id,
        variantTitle: n.title,
        sku: n.sku,
        price: n.price,
        compareAtPrice: n.compareAtPrice,
        cost: n.inventoryItem?.unitCost?.amount ?? null,
        inventoryItemId: n.inventoryItem?.id ?? null,
        currencyCode,
      });
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
  }
  return out;
}

const PRODUCT_VARIANTS_BULK_UPDATE = `#graphql
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }
`;

export type VariantUpdate = {
  id: string; // variant id
  price?: string;
  compareAtPrice?: string | null;
};

export async function updateVariantsForProduct(
  admin: { graphql: GraphQLFn },
  productId: string,
  variants: VariantUpdate[]
): Promise<{ failed: Array<{ variantId: string; message: string }>; succeeded: string[] }> {
  const failed: Array<{ variantId: string; message: string }> = [];
  const succeeded: string[] = [];

  const data = await withRetry(() =>
    runGraphql<{ productVariantsBulkUpdate: { productVariants: Array<{ id: string }> | null; userErrors: Array<{ field: string[]; message: string; code: string }> } }>(
      admin,
      PRODUCT_VARIANTS_BULK_UPDATE,
      {
        productId,
        variants: variants.map((v) => {
          const out: Record<string, unknown> = { id: v.id };
          if (v.price !== undefined) out.price = v.price;
          if (v.compareAtPrice !== undefined) out.compareAtPrice = v.compareAtPrice;
          return out;
        }),
      }
    )
  );

  const errs = data.productVariantsBulkUpdate.userErrors;
  if (errs && errs.length > 0) {
    // Attribute errors to variants by index when possible
    for (const e of errs) {
      const fieldPath = (e.field || []).join(".");
      const match = /variants\.(\d+)/.exec(fieldPath);
      if (match) {
        const idx = parseInt(match[1], 10);
        const v = variants[idx];
        if (v) {
          failed.push({ variantId: v.id, message: e.message });
          continue;
        }
      }
      // Unattributed error, apply to all in batch
      for (const v of variants) failed.push({ variantId: v.id, message: e.message });
    }
  }
  const okIds = (data.productVariantsBulkUpdate.productVariants || []).map((p) => p.id);
  for (const id of okIds) if (!failed.find((f) => f.variantId === id)) succeeded.push(id);
  return { failed, succeeded };
}

const INVENTORY_ITEM_UPDATE = `#graphql
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id unitCost { amount } }
      userErrors { message field }
    }
  }
`;

export async function updateInventoryItemCost(
  admin: { graphql: GraphQLFn },
  inventoryItemId: string,
  cost: string
): Promise<{ ok: boolean; message?: string }> {
  const data = await withRetry(() =>
    runGraphql<{ inventoryItemUpdate: { userErrors: Array<{ message: string; field: string[] }> } }>(
      admin,
      INVENTORY_ITEM_UPDATE,
      { id: inventoryItemId, input: { cost } }
    )
  );
  const errs = data.inventoryItemUpdate.userErrors;
  if (errs && errs.length > 0) return { ok: false, message: errs[0].message };
  return { ok: true };
}
