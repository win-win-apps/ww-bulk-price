import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  InlineStack,
  Divider,
  ChoiceList,
  Collapsible,
  Badge,
  Tag,
  Box,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { fetchAllVariants, type VariantRow } from "../utils/shopify-queries.server";
import {
  buildAdjustmentDiffs,
  describeAdjustment,
  type AdjustmentInput,
  type AdjustmentMode,
  type AdjustmentScope,
  type CompareAtMode,
  type Condition,
  type ConditionField,
  type ConditionOperator,
  type Conjunction,
  type RoundingRule,
} from "../utils/adjustments.server";
import { stageDiffs } from "../utils/staging.server";

type LoaderData = {
  totalVariants: number;
  sampleVariant: {
    title: string;
    price: string;
    compareAtPrice: string | null;
    currency: string;
  } | null;
};

function collectFacets(variants: VariantRow[]): LoaderData {
  const first = variants[0];
  return {
    totalVariants: variants.length,
    sampleVariant: first
      ? {
          title: first.productTitle,
          price: first.price,
          compareAtPrice: first.compareAtPrice,
          currency: first.currencyCode,
        }
      : null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const variants = await fetchAllVariants(admin);
  return json(collectFacets(variants));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.formData();

  const title = String(body.get("title") || "").trim();
  const ruleKind = String(body.get("rule_kind") || "adjust"); // "adjust" | "sale"
  const mode = (String(body.get("mode") || "percent")) as AdjustmentMode;
  const amountStr = String(body.get("amount") || "0");
  const amount = Number(amountStr);
  const rounding = (String(body.get("rounding") || "none")) as RoundingRule;
  const compareAt = (String(body.get("compare_at_mode") || "leave")) as CompareAtMode;
  const compareAtAmountStr = String(body.get("compare_at_amount") || "");
  const compareAtAmount = compareAtAmountStr ? Number(compareAtAmountStr) : undefined;

  const scopeMode = (String(body.get("scope_mode") || "all")) as AdjustmentScope;
  const pickedProductIds = body.getAll("picked_product_ids").map(String).filter(Boolean);
  const pickedVariantIds = body.getAll("picked_variant_ids").map(String).filter(Boolean);
  const conjunction = (String(body.get("conjunction") || "AND")) as Conjunction;
  const conditionsJson = String(body.get("conditions_json") || "[]");
  let parsedConditions: Condition[] = [];
  try {
    const raw = JSON.parse(conditionsJson);
    if (Array.isArray(raw)) {
      parsedConditions = raw
        .map((r: any): Condition | null => {
          if (!r || typeof r !== "object") return null;
          if (typeof r.field !== "string" || typeof r.operator !== "string") return null;
          return {
            field: r.field as ConditionField,
            operator: r.operator as ConditionOperator,
            value: String(r.value ?? ""),
          };
        })
        .filter((c): c is Condition => c != null);
    }
  } catch {
    parsedConditions = [];
  }

  if (Number.isNaN(amount)) return json({ error: "Amount must be a number." });
  if (ruleKind === "adjust" && amount === 0 && compareAt === "leave") {
    return json({ error: "Amount can not be zero if there is nothing else to change." });
  }

  if (scopeMode === "specific" && pickedProductIds.length === 0 && pickedVariantIds.length === 0) {
    return json({ error: "You picked 'Specific products' but no products or variants were selected." });
  }
  if (scopeMode === "conditions" && parsedConditions.length === 0) {
    return json({ error: "Add at least one condition, or switch to 'All products'." });
  }

  // "Create sale" is a convenience preset:
  //   - mode = percent, amount = user-provided negative number
  //   - compare-at mode = "sale" (compare_at becomes original price)
  const effectiveCompareAt: CompareAtMode = ruleKind === "sale" ? "sale" : compareAt;
  const effectiveAmount = ruleKind === "sale" ? -Math.abs(amount) : amount;

  const input: AdjustmentInput = {
    scope: scopeMode,
    productIds: scopeMode === "specific" ? pickedProductIds : undefined,
    variantIds: scopeMode === "specific" ? pickedVariantIds : undefined,
    conditions: scopeMode === "conditions" ? parsedConditions : undefined,
    conjunction: scopeMode === "conditions" ? conjunction : undefined,
    mode,
    amount: effectiveAmount,
    rounding,
    compareAt: effectiveCompareAt,
    compareAtAmount,
  };

  const variants = await fetchAllVariants(admin);
  const diffs = buildAdjustmentDiffs(input, variants);
  if (diffs.length === 0) {
    return json({ error: "No variants matched this rule. Try loosening your filter or adjusting the amount." });
  }

  const scopeLabel =
    scopeMode === "all" ? "all products" :
    scopeMode === "specific" ? "selected products" :
    "filtered products";
  const autoTitle =
    title ||
    (ruleKind === "sale"
      ? `Sale ${Math.abs(amount)}% off`
      : `${mode === "percent" ? `${amount > 0 ? "+" : ""}${amount}%` : `${amount > 0 ? "+" : ""}$${Math.abs(amount).toFixed(2)}`} on ${scopeLabel}`);
  const description = describeAdjustment(input, diffs.length);

  const currentMap = new Map(variants.map((v) => [v.variantId, v]));
  const id = stageDiffs({
    shop: session.shop,
    diffs,
    fileName: autoTitle,
    source: ruleKind === "sale" ? "sale" : "adjustment",
    title: autoTitle,
    description,
    currentByVariant: currentMap,
  });
  return redirect(`/app/preview/${id}`);
};

function defaultTitle(): string {
  const d = new Date();
  const mm = d.toLocaleString("en-US", { month: "short" });
  const dd = d.getDate();
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${mm} ${dd}, ${h}:${m} price change`;
}

// Field definitions drive the operator set and value control for each condition row.
type FieldDef = {
  label: string;
  operators: ConditionOperator[];
  valueKind: "text" | "number" | "status" | "giftcard";
};

const FIELD_DEFS: Record<ConditionField, FieldDef> = {
  product_title: {
    label: "The product's title",
    operators: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"],
    valueKind: "text",
  },
  product_type: {
    label: "The product's type",
    operators: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"],
    valueKind: "text",
  },
  vendor: {
    label: "The product's vendor",
    operators: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"],
    valueKind: "text",
  },
  tag: {
    label: "The product's tag",
    operators: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"],
    valueKind: "text",
  },
  variant_title: {
    label: "The variant's title",
    operators: ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"],
    valueKind: "text",
  },
  product_status: {
    label: "The product's status",
    operators: ["is", "is_not"],
    valueKind: "status",
  },
  gift_card: {
    label: "Gift cards",
    operators: ["is", "is_not"],
    valueKind: "giftcard",
  },
  inventory_quantity: {
    label: "Inventory quantity",
    operators: ["is", "is_not", "gt", "lt", "gte", "lte"],
    valueKind: "number",
  },
};

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  is: "is equal to",
  is_not: "is not equal to",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: "is greater than",
  lt: "is less than",
  gte: "is greater than or equal to",
  lte: "is less than or equal to",
};

type PickedProduct = { id: string; title: string };
type PickedVariant = { id: string; title: string; productTitle: string };

export default function AdjustPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const nav = useNavigation();
  const shopify = useAppBridge();
  const submitting = nav.state !== "idle";

  const [title, setTitle] = useState<string>(defaultTitle());
  const [ruleKind, setRuleKind] = useState<"adjust" | "sale">("adjust");
  const [mode, setMode] = useState<AdjustmentMode>("percent");
  const [amount, setAmount] = useState<string>("10");
  const [rounding, setRounding] = useState<RoundingRule>("none");
  const [showRounding, setShowRounding] = useState(false);
  const [compareAt, setCompareAt] = useState<CompareAtMode>("leave");

  // Scope state
  const [scopeMode, setScopeMode] = useState<AdjustmentScope>("all");
  const [pickedProducts, setPickedProducts] = useState<PickedProduct[]>([]);
  const [pickedVariants, setPickedVariants] = useState<PickedVariant[]>([]);
  const [conjunction, setConjunction] = useState<Conjunction>("AND");
  const [conditions, setConditions] = useState<Condition[]>([
    { field: "product_type", operator: "is", value: "" },
  ]);

  // Resource picker handlers. Uses App Bridge shopify.resourcePicker which pops
  // the native Shopify selector so merchants can pick products or variants.
  const openProductPicker = useCallback(async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "select",
      });
      if (!selected) return;
      // selected is Array<{id, title, variants: Array<{id, title, ...}>}> in latest App Bridge
      const nextProducts: PickedProduct[] = [];
      const nextVariants: PickedVariant[] = [];
      for (const item of selected as any[]) {
        if (!item) continue;
        // If merchant picked every variant of a product (or the product itself),
        // we store it as a "whole product" entry. Otherwise each selected variant
        // goes into the variants bucket.
        const rawVariants = Array.isArray(item.variants) ? item.variants : [];
        const allVariantsSelected = rawVariants.length > 0 && rawVariants.every((v: any) => v.selected !== false);
        if (allVariantsSelected || item.variants == null) {
          nextProducts.push({ id: String(item.id), title: String(item.title || "Untitled product") });
        } else {
          for (const v of rawVariants) {
            if (v && v.selected !== false) {
              nextVariants.push({
                id: String(v.id),
                title: String(v.title || "Default"),
                productTitle: String(item.title || ""),
              });
            }
          }
        }
      }
      setPickedProducts(nextProducts);
      setPickedVariants(nextVariants);
    } catch (err) {
      // Cancel is not an error; swallow
      console.debug("resourcePicker closed:", err);
    }
  }, [shopify]);

  const openVariantPicker = useCallback(async () => {
    try {
      const selected = await shopify.resourcePicker({
        type: "variant",
        multiple: true,
        action: "select",
      });
      if (!selected) return;
      const nextVariants: PickedVariant[] = [];
      for (const item of selected as any[]) {
        if (!item) continue;
        nextVariants.push({
          id: String(item.id),
          title: String(item.title || "Default"),
          productTitle: String(item.product?.title || ""),
        });
      }
      setPickedVariants(nextVariants);
      setPickedProducts([]);
    } catch (err) {
      console.debug("resourcePicker closed:", err);
    }
  }, [shopify]);

  const removePickedProduct = useCallback((id: string) => {
    setPickedProducts((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const removePickedVariant = useCallback((id: string) => {
    setPickedVariants((prev) => prev.filter((v) => v.id !== id));
  }, []);

  // Condition mutation helpers
  const addCondition = useCallback(() => {
    setConditions((prev) => [...prev, { field: "product_type", operator: "is", value: "" }]);
  }, []);
  const updateCondition = useCallback((idx: number, patch: Partial<Condition>) => {
    setConditions((prev) => prev.map((c, i) => {
      if (i !== idx) return c;
      const merged = { ...c, ...patch };
      // If field changed and the current operator is no longer valid for the new field, pick the first valid one.
      if (patch.field && patch.field !== c.field) {
        const allowed = FIELD_DEFS[patch.field as ConditionField].operators;
        if (!allowed.includes(merged.operator)) {
          merged.operator = allowed[0];
        }
        // Also reset value when the valueKind changes meaningfully
        const prevKind = FIELD_DEFS[c.field].valueKind;
        const nextKind = FIELD_DEFS[patch.field as ConditionField].valueKind;
        if (prevKind !== nextKind) merged.value = "";
      }
      return merged;
    }));
  }, []);
  const removeCondition = useCallback((idx: number) => {
    setConditions((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Live preview: compute what one sample variant would look like after the rule
  const preview = useMemo(() => {
    if (!data.sampleVariant) return null;
    const base = Number(data.sampleVariant.price);
    if (Number.isNaN(base)) return null;
    const n = Number(amount);
    if (Number.isNaN(n)) return null;
    const effAmount = ruleKind === "sale" ? -Math.abs(n) : n;
    let after = base;
    if (mode === "percent") after = base * (1 + effAmount / 100);
    else if (mode === "fixed") after = base + effAmount;
    else if (mode === "set_to") after = effAmount;
    if (after < 0) after = 0;
    if (rounding === "end_99") {
      const whole = Math.floor(after);
      const low = Math.max(0, whole - 1) + 0.99;
      const high = whole + 0.99;
      after = Math.abs(after - high) <= Math.abs(after - low) ? high : low;
    } else if (rounding === "end_95") {
      const whole = Math.floor(after);
      const low = Math.max(0, whole - 1) + 0.95;
      const high = whole + 0.95;
      after = Math.abs(after - high) <= Math.abs(after - low) ? high : low;
    } else if (rounding === "end_00") {
      after = Math.round(after);
    } else {
      after = Math.round(after * 100) / 100;
    }
    const compareAfter =
      ruleKind === "sale" ? base.toFixed(2) :
      compareAt === "sale" ? base.toFixed(2) :
      compareAt === "clear" ? null :
      data.sampleVariant.compareAtPrice;
    const fmt = (v: number) => `$${v.toFixed(2)}`;
    return {
      title: data.sampleVariant.title,
      beforePrice: fmt(base),
      beforeCompare: data.sampleVariant.compareAtPrice ? `$${Number(data.sampleVariant.compareAtPrice).toFixed(2)}` : null,
      afterPrice: fmt(after),
      afterCompare: compareAfter ? `$${Number(compareAfter).toFixed(2)}` : null,
    };
  }, [data.sampleVariant, amount, mode, rounding, compareAt, ruleKind]);

  return (
    <Page
      title="Create new price change job"
      subtitle="Adjust prices in bulk with a percent, fixed amount, or sale preset. Preview before anything is written."
      backAction={{ url: "/app" }}
    >
      <Form method="post">
        <BlockStack gap="500">
          {actionData?.error && <Banner tone="critical" title={actionData.error} />}

          {/* Step 1: Title */}
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Step 1.</Text>
                <Text as="span" variant="headingMd" tone="subdued">Give this job a title</Text>
              </InlineStack>
              <TextField
                label='eg "March 30% off sale on boots"'
                value={title}
                onChange={setTitle}
                name="title"
                autoComplete="off"
                helpText="This title is just for your history. Customers do not see it."
              />
            </BlockStack>
          </Card>

          {/* Step 2: Price rule */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Step 2.</Text>
                <Text as="span" variant="headingMd" tone="subdued">Select how prices should change</Text>
              </InlineStack>

              <ChoiceList
                title=""
                titleHidden
                selected={[ruleKind]}
                choices={[
                  {
                    label: "Use bulk price change rules",
                    value: "adjust",
                    helpText: "Adjust regular price by a percent, fixed amount, or set to a specific value.",
                  },
                  {
                    label: "Create sale",
                    value: "sale",
                    helpText: "Drop the price by a percent and move the original price to compare-at (strikethrough).",
                    renderChildren: () => <Badge tone="success">shortcut</Badge>,
                  },
                ]}
                onChange={(v) => setRuleKind((v[0] || "adjust") as "adjust" | "sale")}
                name="rule_kind"
              />

              <Divider />

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Price</Text>
                {ruleKind === "adjust" ? (
                  <Select
                    label="Change type"
                    options={[
                      { label: "Change the price by a percentage", value: "percent" },
                      { label: "Change the price by a fixed amount", value: "fixed" },
                      { label: "Set price to a specific value", value: "set_to" },
                    ]}
                    value={mode}
                    onChange={(v) => setMode(v as AdjustmentMode)}
                    name="mode"
                  />
                ) : (
                  <>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      In sale mode we always drop the price by a percentage and keep the original as compare-at.
                    </Text>
                    <input type="hidden" name="mode" value="percent" />
                  </>
                )}
                <TextField
                  label={
                    ruleKind === "sale"
                      ? "Sale percentage off (positive number)"
                      : mode === "percent"
                      ? "Price change amount (% change, e.g. 10 for +10%, -5 for -5%)"
                      : mode === "fixed"
                      ? "Price change amount (fixed, e.g. 2.50 or -2.50)"
                      : "Set price to"
                  }
                  value={amount}
                  onChange={setAmount}
                  name="amount"
                  type="number"
                  step={0.01}
                  autoComplete="off"
                  suffix={mode === "percent" && ruleKind === "adjust" ? "%" : ruleKind === "sale" ? "% off" : undefined}
                  prefix={mode !== "percent" && ruleKind === "adjust" ? "$" : undefined}
                />
                <Button
                  variant="plain"
                  onClick={() => setShowRounding((s) => !s)}
                  ariaExpanded={showRounding}
                >
                  {showRounding ? "Hide rounding options" : "Show rounding options"}
                </Button>
                <Collapsible
                  open={showRounding}
                  id="rounding-collapsible"
                  transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                >
                  <Box paddingBlockStart="200">
                    <Select
                      label="Rounding rule"
                      helpText="Optional. Snaps each new price to a charm-pricing ending."
                      options={[
                        { label: "None (keep exact cents)", value: "none" },
                        { label: "End in .99", value: "end_99" },
                        { label: "End in .95", value: "end_95" },
                        { label: "Whole dollar", value: "end_00" },
                      ]}
                      value={rounding}
                      onChange={(v) => setRounding(v as RoundingRule)}
                      name="rounding"
                    />
                  </Box>
                </Collapsible>
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Compare at price</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  The struck-through price shoppers see next to the sale price.
                </Text>
                {ruleKind === "sale" ? (
                  <>
                    <Banner tone="info">
                      <Text as="p" variant="bodyMd">
                        Sale mode sets compare-at to the original price automatically so your storefront
                        shows a strikethrough.
                      </Text>
                    </Banner>
                    <input type="hidden" name="compare_at_mode" value="sale" />
                  </>
                ) : (
                  <Select
                    label="Change type"
                    options={[
                      { label: "Leave compare-at alone", value: "leave" },
                      { label: "Set compare-at to the current price (create strikethrough)", value: "sale" },
                      { label: "Clear compare-at", value: "clear" },
                      { label: "Adjust compare-at by the same percentage as price", value: "percent" },
                      { label: "Adjust compare-at by the same fixed amount as price", value: "fixed" },
                    ]}
                    value={compareAt}
                    onChange={(v) => setCompareAt(v as CompareAtMode)}
                    name="compare_at_mode"
                  />
                )}
              </BlockStack>

              {/* Storefront example */}
              {preview && (
                <>
                  <Divider />
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Storefront example</Text>
                    <Text as="p" variant="bodyMd" tone="subdued">Using "{preview.title}" as a sample.</Text>
                    <InlineStack gap="400" align="start" wrap={false}>
                      <Box
                        padding="400"
                        borderWidth="025"
                        borderColor="border"
                        borderRadius="200"
                        minWidth="180px"
                      >
                        <BlockStack gap="100">
                          <Text as="span" variant="bodySm" tone="subdued">Before</Text>
                          <Text as="span" variant="headingMd">{preview.beforePrice}</Text>
                          {preview.beforeCompare && (
                            <Text as="span" variant="bodySm" tone="subdued">was {preview.beforeCompare}</Text>
                          )}
                        </BlockStack>
                      </Box>
                      <Box paddingBlockStart="400">
                        <Text as="span" variant="headingLg" tone="subdued">→</Text>
                      </Box>
                      <Box
                        padding="400"
                        borderWidth="025"
                        borderColor="border-success"
                        borderRadius="200"
                        minWidth="180px"
                        background="bg-surface-success"
                      >
                        <BlockStack gap="100">
                          <Text as="span" variant="bodySm" tone="subdued">After</Text>
                          <Text as="span" variant="headingMd">{preview.afterPrice}</Text>
                          {preview.afterCompare && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              was <s>{preview.afterCompare}</s>
                            </Text>
                          )}
                        </BlockStack>
                      </Box>
                    </InlineStack>
                  </BlockStack>
                </>
              )}
            </BlockStack>
          </Card>

          {/* Step 3: Scope */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Step 3.</Text>
                <Text as="span" variant="headingMd" tone="subdued">Select which products should change in price</Text>
              </InlineStack>

              <ChoiceList
                title=""
                titleHidden
                selected={[scopeMode]}
                choices={[
                  {
                    label: `All products (${data.totalVariants.toLocaleString()} variants)`,
                    value: "all",
                  },
                  {
                    label: "Specific products or variants",
                    value: "specific",
                    helpText: "Pick individual products or variants from a searchable list.",
                  },
                  {
                    label: "Products matching conditions",
                    value: "conditions",
                    helpText: "Match by vendor, product type, tag, inventory, status, and more. Combine with AND / OR.",
                  },
                ]}
                onChange={(v) => setScopeMode((v[0] || "all") as AdjustmentScope)}
              />
              <input type="hidden" name="scope_mode" value={scopeMode} />

              {/* Specific products branch */}
              {scopeMode === "specific" && (
                <Box paddingBlockStart="200">
                  <BlockStack gap="300">
                    <InlineStack gap="200">
                      <Button onClick={openProductPicker}>Browse products</Button>
                      <Button onClick={openVariantPicker}>Browse variants</Button>
                    </InlineStack>

                    {pickedProducts.length === 0 && pickedVariants.length === 0 ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No products selected yet. Use the buttons above to pick from your catalog.
                      </Text>
                    ) : (
                      <BlockStack gap="200">
                        {pickedProducts.length > 0 && (
                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {pickedProducts.length} product{pickedProducts.length === 1 ? "" : "s"} (all variants)
                            </Text>
                            <InlineStack gap="100" wrap>
                              {pickedProducts.map((p) => (
                                <Tag key={p.id} onRemove={() => removePickedProduct(p.id)}>
                                  {p.title}
                                </Tag>
                              ))}
                            </InlineStack>
                          </BlockStack>
                        )}
                        {pickedVariants.length > 0 && (
                          <BlockStack gap="100">
                            <Text as="p" variant="bodySm" tone="subdued">
                              {pickedVariants.length} individual variant{pickedVariants.length === 1 ? "" : "s"}
                            </Text>
                            <InlineStack gap="100" wrap>
                              {pickedVariants.map((v) => (
                                <Tag key={v.id} onRemove={() => removePickedVariant(v.id)}>
                                  {v.productTitle ? `${v.productTitle} / ${v.title}` : v.title}
                                </Tag>
                              ))}
                            </InlineStack>
                          </BlockStack>
                        )}
                      </BlockStack>
                    )}

                    {/* Hidden inputs for form submission */}
                    {pickedProducts.map((p) => (
                      <input key={`pp-${p.id}`} type="hidden" name="picked_product_ids" value={p.id} />
                    ))}
                    {pickedVariants.map((v) => (
                      <input key={`pv-${v.id}`} type="hidden" name="picked_variant_ids" value={v.id} />
                    ))}
                  </BlockStack>
                </Box>
              )}

              {/* Conditions branch */}
              {scopeMode === "conditions" && (
                <Box paddingBlockStart="200">
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" fontWeight="medium">Products must match:</Text>
                      <ChoiceList
                        title=""
                        titleHidden
                        selected={[conjunction]}
                        choices={[
                          { label: "all conditions", value: "AND" },
                          { label: "any condition", value: "OR" },
                        ]}
                        onChange={(v) => setConjunction((v[0] || "AND") as Conjunction)}
                      />
                      <input type="hidden" name="conjunction" value={conjunction} />
                    </BlockStack>

                    <BlockStack gap="300">
                      {conditions.map((c, idx) => (
                        <ConditionRow
                          key={idx}
                          condition={c}
                          onChange={(patch) => updateCondition(idx, patch)}
                          onDelete={conditions.length > 1 ? () => removeCondition(idx) : undefined}
                        />
                      ))}
                    </BlockStack>

                    <InlineStack>
                      <Button icon={PlusIcon} onClick={addCondition}>
                        Add another condition
                      </Button>
                    </InlineStack>

                    {/* Serialized conditions for submission */}
                    <input type="hidden" name="conditions_json" value={JSON.stringify(conditions)} />
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          </Card>

          {/* Step 4: When */}
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Step 4.</Text>
                <Text as="span" variant="headingMd" tone="subdued">Select when the prices should change</Text>
              </InlineStack>
              <ChoiceList
                title=""
                titleHidden
                selected={["now"]}
                choices={[
                  { label: "Change prices now", value: "now" },
                  {
                    label: "Change prices later",
                    value: "later",
                    disabled: true,
                    helpText: "Coming in v1.1. Ping us if this is blocking you.",
                  },
                ]}
                onChange={() => { /* fixed to "now" in v1 */ }}
              />
            </BlockStack>
          </Card>

          <InlineStack gap="200" align="end">
            <Button url="/app">Cancel</Button>
            <Button submit variant="primary" loading={submitting}>
              Preview changes
            </Button>
          </InlineStack>
        </BlockStack>
      </Form>
    </Page>
  );
}

/**
 * One row in the conditions list. Field + operator + value + delete.
 * Operator and value control dynamically update when the field changes.
 */
function ConditionRow({
  condition,
  onChange,
  onDelete,
}: {
  condition: Condition;
  onChange: (patch: Partial<Condition>) => void;
  onDelete?: () => void;
}) {
  const def = FIELD_DEFS[condition.field];
  const fieldOptions = (Object.keys(FIELD_DEFS) as ConditionField[]).map((f) => ({
    label: FIELD_DEFS[f].label,
    value: f,
  }));
  const operatorOptions = def.operators.map((op) => ({
    label: OPERATOR_LABELS[op],
    value: op,
  }));

  let valueControl: React.ReactNode;
  if (def.valueKind === "status") {
    valueControl = (
      <Select
        label=""
        labelHidden
        options={[
          { label: "Select status", value: "" },
          { label: "Active", value: "ACTIVE" },
          { label: "Draft", value: "DRAFT" },
          { label: "Archived", value: "ARCHIVED" },
        ]}
        value={condition.value}
        onChange={(v) => onChange({ value: v })}
      />
    );
  } else if (def.valueKind === "giftcard") {
    valueControl = (
      <Select
        label=""
        labelHidden
        options={[
          { label: "Select", value: "" },
          { label: "A gift card", value: "true" },
          { label: "Not a gift card", value: "false" },
        ]}
        value={condition.value}
        onChange={(v) => onChange({ value: v })}
      />
    );
  } else if (def.valueKind === "number") {
    valueControl = (
      <TextField
        label=""
        labelHidden
        value={condition.value}
        onChange={(v) => onChange({ value: v })}
        type="number"
        autoComplete="off"
        placeholder="0"
      />
    );
  } else {
    valueControl = (
      <TextField
        label=""
        labelHidden
        value={condition.value}
        onChange={(v) => onChange({ value: v })}
        autoComplete="off"
        placeholder="Type a value"
      />
    );
  }

  return (
    <Box
      padding="300"
      borderWidth="025"
      borderColor="border"
      borderRadius="200"
      background="bg-surface-secondary"
    >
      <InlineStack gap="200" align="start" blockAlign="start" wrap={false}>
        <Box minWidth="200px">
          <Select
            label=""
            labelHidden
            options={fieldOptions}
            value={condition.field}
            onChange={(v) => onChange({ field: v as ConditionField })}
          />
        </Box>
        <Box minWidth="180px">
          <Select
            label=""
            labelHidden
            options={operatorOptions}
            value={condition.operator}
            onChange={(v) => onChange({ operator: v as ConditionOperator })}
          />
        </Box>
        <Box minWidth="220px">
          {valueControl}
        </Box>
        {onDelete && (
          <Button
            icon={DeleteIcon}
            accessibilityLabel="Remove condition"
            onClick={onDelete}
            variant="tertiary"
          />
        )}
      </InlineStack>
    </Box>
  );
}
