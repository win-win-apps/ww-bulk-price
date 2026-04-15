import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "@remix-run/react";
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
  DataTable,
  Pagination,
} from "@shopify/polaris";
import { ArrowLeftIcon, DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { fetchAllVariants, fetchAllCollections, type CollectionRow, type VariantRow } from "../utils/shopify-queries.server";
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
  // Facets used by the condition row value selectors so merchants pick from
  // real values in their store instead of typing free text.
  productTypes: string[];
  vendors: string[];
  tags: string[];
  variantTitles: string[];
  productTitles: string[];
  // Collections are id + title pairs because the value we match on is the id
  // but we want to show the title in the UI.
  collections: Array<{ id: string; title: string }>;
};

function collectFacets(variants: VariantRow[], collections: CollectionRow[]): LoaderData {
  const first = variants[0];
  const productTypes = new Set<string>();
  const vendors = new Set<string>();
  const tags = new Set<string>();
  const variantTitles = new Set<string>();
  const productTitles = new Set<string>();
  for (const v of variants) {
    if (v.productType) productTypes.add(v.productType);
    if (v.vendor) vendors.add(v.vendor);
    for (const t of v.tags || []) if (t) tags.add(t);
    if (v.variantTitle) variantTitles.add(v.variantTitle);
    if (v.productTitle) productTitles.add(v.productTitle);
  }
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
    productTypes: Array.from(productTypes).sort(),
    vendors: Array.from(vendors).sort(),
    tags: Array.from(tags).sort(),
    variantTitles: Array.from(variantTitles).sort(),
    // Cap product titles to keep payload bounded on large stores; merchants can
    // always switch to "contains" to hand-type for giant catalogs.
    productTitles: Array.from(productTitles).sort().slice(0, 500),
    collections: collections
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => ({ id: c.id, title: c.title })),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [variants, collections] = await Promise.all([
    fetchAllVariants(admin),
    fetchAllCollections(admin),
  ]);
  return json(collectFacets(variants, collections));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.formData();

  // intent: "apply" (default) stages diffs and redirects to the full preview
  // page, "preview" returns the computed diff list as JSON so we can render
  // an inline preview right below Step 3 without leaving the adjust page.
  const intent = String(body.get("intent") || "apply");
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

  // Preview intent: return the diff list and get out. Do not stage anything,
  // do not redirect. The UI will render this inline under Step 3.
  if (intent === "preview") {
    return json({
      preview: {
        diffs,
        totalMatched: diffs.length,
        totalVariants: variants.length,
      },
    });
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
  valueKind: "text" | "number" | "status" | "giftcard" | "collection";
};

const FIELD_DEFS: Record<ConditionField, FieldDef> = {
  product_collection: {
    label: "The product's collection",
    operators: ["is", "is_not"],
    valueKind: "collection",
  },
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

type PreviewDiff = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
  before: { price: string; compareAtPrice: string | null };
  after: { price: string; compareAtPrice: string | null };
  priceChanged: boolean;
  compareChanged: boolean;
  pctChange: number | null;
  flags: string[];
};

type PreviewPayload = {
  preview: {
    diffs: PreviewDiff[];
    totalMatched: number;
    totalVariants: number;
  };
};

export default function AdjustPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const nav = useNavigation();
  const shopify = useAppBridge();
  const submitting = nav.state !== "idle";

  // Guided flow: 4 steps, each in its own panel. We use display:none to hide
  // inactive panels so form inputs from earlier steps remain mounted and are
  // included in the final apply submit.
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4>(1);
  const [stepError, setStepError] = useState<string | null>(null);

  // Fetcher for the inline preview under Step 3. Uses intent=preview to tell
  // the action to return JSON instead of staging and redirecting.
  const previewFetcher = useFetcher<any>();
  const formRef = useRef<HTMLFormElement>(null);
  const previewLoading = previewFetcher.state !== "idle";
  const previewPayload: PreviewPayload["preview"] | null =
    previewFetcher.data && previewFetcher.data.preview ? previewFetcher.data.preview : null;
  const previewError: string | null =
    previewFetcher.data && previewFetcher.data.error ? previewFetcher.data.error : null;
  const [previewPage, setPreviewPage] = useState(0);
  const previewPageSize = 50;
  // reset page when a new result comes in
  useEffect(() => {
    setPreviewPage(0);
  }, [previewPayload?.totalMatched]);

  const computePreview = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    fd.set("intent", "preview");
    previewFetcher.submit(fd, { method: "post" });
  }, [previewFetcher]);

  const [title, setTitle] = useState<string>(defaultTitle());
  const [ruleKind, setRuleKind] = useState<"adjust" | "sale">("sale");
  const [mode, setMode] = useState<AdjustmentMode>("percent");
  const [amount, setAmount] = useState<string>("10");
  const [rounding, setRounding] = useState<RoundingRule>("none");
  const [showRounding, setShowRounding] = useState(false);
  const [compareAt, setCompareAt] = useState<CompareAtMode>("leave");

  // Scope state. scopePickerOpen controls whether we show the 3 cards or the
  // expanded body of the selected card with a back button.
  const [scopeMode, setScopeMode] = useState<AdjustmentScope>("all");
  const [scopePickerOpen, setScopePickerOpen] = useState<boolean>(true);
  const [pickedProducts, setPickedProducts] = useState<PickedProduct[]>([]);
  const [pickedVariants, setPickedVariants] = useState<PickedVariant[]>([]);

  const chooseScope = useCallback((mode: AdjustmentScope) => {
    setScopeMode(mode);
    setScopePickerOpen(false);
  }, []);
  const backToScopePicker = useCallback(() => {
    setScopePickerOpen(true);
  }, []);
  const [conjunction, setConjunction] = useState<Conjunction>("AND");
  const [conditions, setConditions] = useState<Condition[]>([
    { field: "product_collection", operator: "is", value: "" },
  ]);

  // Re-run the preview whenever the merchant enters Step 4 so it always
  // reflects the latest rule and scope.
  useEffect(() => {
    if (currentStep !== 4) return;
    const t = setTimeout(() => computePreview(), 0);
    return () => clearTimeout(t);
  }, [currentStep, computePreview]);

  // Validation for advancing to the next step. Returns an error message on
  // failure or null when the step is valid and the merchant can proceed.
  const validateStep = useCallback((step: 1 | 2 | 3): string | null => {
    if (step === 1) {
      if (!title.trim()) return "Give this job a title before continuing.";
      return null;
    }
    if (step === 2) {
      const n = Number(amount);
      if (Number.isNaN(n)) return "Enter a valid number for the price change amount.";
      if (ruleKind === "adjust" && n === 0 && compareAt === "leave") {
        return "Amount can not be zero if there is nothing else to change.";
      }
      return null;
    }
    if (step === 3) {
      if (scopeMode === "specific" && pickedProducts.length === 0 && pickedVariants.length === 0) {
        return "Pick at least one product or variant, or switch to a different scope.";
      }
      if (scopeMode === "conditions") {
        if (conditions.length === 0) return "Add at least one condition or switch to All products.";
        const missing = conditions.some((c) => !c.value.trim());
        if (missing) return "Fill in a value for every condition row.";
      }
      return null;
    }
    return null;
  }, [title, amount, ruleKind, compareAt, scopeMode, pickedProducts, pickedVariants, conditions]);

  const goNext = useCallback(() => {
    if (currentStep === 4) return;
    const err = validateStep(currentStep);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setCurrentStep((s) => (s < 4 ? ((s + 1) as 1 | 2 | 3 | 4) : s));
  }, [currentStep, validateStep]);

  const goBack = useCallback(() => {
    setStepError(null);
    setCurrentStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : s));
  }, []);

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

  const removePickedProduct = useCallback((id: string) => {
    setPickedProducts((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const removePickedVariant = useCallback((id: string) => {
    setPickedVariants((prev) => prev.filter((v) => v.id !== id));
  }, []);

  // Condition mutation helpers
  const addCondition = useCallback(() => {
    setConditions((prev) => [...prev, { field: "product_collection", operator: "is", value: "" }]);
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
      subtitle="Guided 4 step flow. Nothing is written to your store until the final apply."
      backAction={{ url: "/app" }}
    >
      <Form method="post" ref={formRef}>
        <div style={{ maxWidth: 500, margin: "0 auto" }}>
        <BlockStack gap="500">
          {actionData?.error && <Banner tone="critical" title={actionData.error} />}
          {stepError && <Banner tone="critical" title={stepError} />}

          <Stepper
            currentStep={currentStep}
            steps={["Title", "Pricing rule", "Which products", "Review & apply"]}
            onJump={(n) => {
              // Only allow jumping back, never forward past unvalidated steps
              if (n < currentStep) {
                setStepError(null);
                setCurrentStep(n);
              }
            }}
          />

          {/* Step 1: Title */}
          <div style={{ display: currentStep === 1 ? undefined : "none" }}>
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
          </div>

          {/* Step 2: Price rule */}
          <div style={{ display: currentStep === 2 ? undefined : "none" }}>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Step 2.</Text>
                <Text as="span" variant="headingMd" tone="subdued">Select how prices should change</Text>
              </InlineStack>

              <input type="hidden" name="rule_kind" value={ruleKind} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <RuleKindTile
                  selected={ruleKind === "sale"}
                  onClick={() => setRuleKind("sale")}
                  title="Sale"
                  subtext="Drop the price by a percent and move the original to compare-at for a strikethrough."
                />
                <RuleKindTile
                  selected={ruleKind === "adjust"}
                  onClick={() => setRuleKind("adjust")}
                  title="Custom price adjustment"
                  subtext="Change price by a percent, a fixed amount, or set it to a specific value."
                />
              </div>

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
          </div>

          {/* Step 3: Scope */}
          <div style={{ display: currentStep === 3 ? undefined : "none" }}>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">Step 3.</Text>
                <Text as="span" variant="headingMd" tone="subdued">Select which products should change in price</Text>
              </InlineStack>

              <input type="hidden" name="scope_mode" value={scopeMode} />

              {scopePickerOpen ? (
                <BlockStack gap="300">
                  <ScopeCard
                    title={`All products (${data.totalVariants.toLocaleString()} variants)`}
                    description="Apply this price change to every variant in your catalog."
                    selected={scopeMode === "all"}
                    onClick={() => chooseScope("all")}
                  />
                  <ScopeCard
                    title="Specific products"
                    description="Pick individual products or variants from a searchable list."
                    selected={scopeMode === "specific"}
                    onClick={() => chooseScope("specific")}
                  />
                  <ScopeCard
                    title="Products matching conditions"
                    description="Match by vendor, product type, tag, inventory, status, and more. Combine with AND or OR."
                    selected={scopeMode === "conditions"}
                    onClick={() => chooseScope("conditions")}
                  />
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Button variant="plain" icon={ArrowLeftIcon} onClick={backToScopePicker}>
                      Change selection
                    </Button>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      {scopeMode === "all" ? "All products" : scopeMode === "specific" ? "Specific products" : "Products matching conditions"}
                    </Text>
                  </InlineStack>

                  {/* All products summary */}
                  {scopeMode === "all" && (
                    <Box padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                      <Text as="p" variant="bodyMd">
                        Every variant in your catalog ({data.totalVariants.toLocaleString()} total) will be updated by this rule.
                      </Text>
                    </Box>
                  )}

                  {/* Specific products branch */}
                  {scopeMode === "specific" && (
                  <BlockStack gap="300">
                    <InlineStack gap="200">
                      <Button onClick={openProductPicker}>Select products</Button>
                    </InlineStack>

                    {pickedProducts.length === 0 && pickedVariants.length === 0 ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No products selected yet. Use the button above to pick from your catalog. You can also expand a product in the picker to choose only specific variants.
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
                  )}

                  {/* Conditions branch */}
                  {scopeMode === "conditions" && (
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
                            facets={{
                              productTypes: data.productTypes,
                              vendors: data.vendors,
                              tags: data.tags,
                              variantTitles: data.variantTitles,
                              productTitles: data.productTitles,
                              collections: data.collections,
                            }}
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
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
          </div>

          {/* Step 4: Review & apply */}
          <div style={{ display: currentStep === 4 ? undefined : "none" }}>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center" align="space-between">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">Step 4.</Text>
                  <Text as="span" variant="headingMd" tone="subdued">
                    Review the changes and apply
                  </Text>
                </InlineStack>
                <Button onClick={computePreview} loading={previewLoading}>
                  Refresh preview
                </Button>
              </InlineStack>

              <ReviewSummary
                title={title}
                ruleKind={ruleKind}
                mode={mode}
                amount={amount}
                compareAt={compareAt}
                rounding={rounding}
                scopeMode={scopeMode}
                pickedProducts={pickedProducts}
                pickedVariants={pickedVariants}
                conditions={conditions}
                conjunction={conjunction}
                totalVariants={data.totalVariants}
              />

              {previewError && <Banner tone="critical" title={previewError} />}

              {previewLoading && !previewPayload && (
                <Text as="p" variant="bodyMd" tone="subdued">
                  Computing the list of variants that will change
                </Text>
              )}

              {previewPayload && (
                <InlinePreviewTable
                  diffs={previewPayload.diffs}
                  page={previewPage}
                  pageSize={previewPageSize}
                  onPageChange={setPreviewPage}
                />
              )}
            </BlockStack>
          </Card>
          </div>

          {/* Guided nav. Back / Next on steps 1-3, Back / Apply on step 4. */}
          <InlineStack gap="200" align="space-between">
            <InlineStack gap="200">
              {currentStep === 1 ? (
                <Button url="/app">Cancel</Button>
              ) : (
                <Button onClick={goBack} icon={ArrowLeftIcon}>Back</Button>
              )}
            </InlineStack>
            <InlineStack gap="200">
              <Text as="span" variant="bodySm" tone="subdued">{`Step ${currentStep} of 4`}</Text>
              {currentStep < 4 ? (
                <Button variant="primary" onClick={goNext}>
                  {currentStep === 3 ? "Review changes" : "Next"}
                </Button>
              ) : (
                <Button
                  submit
                  variant="primary"
                  loading={submitting}
                  disabled={!previewPayload || previewPayload.totalMatched === 0}
                >
                  {previewPayload
                    ? `Apply ${previewPayload.totalMatched} change${previewPayload.totalMatched === 1 ? "" : "s"}`
                    : "Apply"}
                </Button>
              )}
            </InlineStack>
          </InlineStack>
        </BlockStack>
        </div>
      </Form>
    </Page>
  );
}

/**
 * Stepper header shown above all step panels. Each dot is clickable to go
 * back to a previous step but cannot jump ahead past unvalidated steps.
 */
function Stepper({
  currentStep,
  steps,
  onJump,
}: {
  currentStep: 1 | 2 | 3 | 4;
  steps: string[];
  onJump: (n: 1 | 2 | 3 | 4) => void;
}) {
  return (
    <Card>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {steps.map((label, i) => {
          const num = (i + 1) as 1 | 2 | 3 | 4;
          const done = num < currentStep;
          const active = num === currentStep;
          const clickable = num < currentStep;
          return (
            <InlineStack key={label} gap="200" blockAlign="center" wrap={false}>
              <div
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : -1}
                onClick={() => clickable && onJump(num)}
                onKeyDown={(e) => {
                  if (clickable && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onJump(num);
                  }
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: clickable ? "pointer" : "default",
                  opacity: done || active ? 1 : 0.55,
                }}
              >
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 600,
                    fontSize: 13,
                    color: active || done ? "#fff" : "var(--p-color-text-subdued)",
                    background: active
                      ? "var(--p-color-bg-fill-brand)"
                      : done
                      ? "var(--p-color-bg-fill-success)"
                      : "var(--p-color-bg-surface-secondary)",
                    border: "1px solid var(--p-color-border)",
                  }}
                >
                  {done ? "\u2713" : num}
                </div>
                <Text as="span" variant="bodyMd" fontWeight={active ? "semibold" : "regular"}>
                  {label}
                </Text>
              </div>
              {i < steps.length - 1 && (
                <div
                  aria-hidden
                  style={{
                    width: 28,
                    height: 2,
                    background: "var(--p-color-border)",
                  }}
                />
              )}
            </InlineStack>
          );
        })}
      </InlineStack>
    </Card>
  );
}

/**
 * Plain English summary of the rule + scope shown at the top of Step 4 so
 * merchants can double-check what they're about to apply without scrolling.
 */
function ReviewSummary({
  title,
  ruleKind,
  mode,
  amount,
  compareAt,
  rounding,
  scopeMode,
  pickedProducts,
  pickedVariants,
  conditions,
  conjunction,
  totalVariants,
}: {
  title: string;
  ruleKind: "adjust" | "sale";
  mode: AdjustmentMode;
  amount: string;
  compareAt: CompareAtMode;
  rounding: RoundingRule;
  scopeMode: AdjustmentScope;
  pickedProducts: PickedProduct[];
  pickedVariants: PickedVariant[];
  conditions: Condition[];
  conjunction: Conjunction;
  totalVariants: number;
}) {
  const n = Number(amount) || 0;
  let ruleText = "";
  if (ruleKind === "sale") {
    ruleText = `Drop price by ${Math.abs(n)}% and move original to compare-at`;
  } else if (mode === "percent") {
    ruleText = `${n >= 0 ? "Raise" : "Lower"} price by ${Math.abs(n)}%`;
  } else if (mode === "fixed") {
    ruleText = `${n >= 0 ? "Raise" : "Lower"} price by $${Math.abs(n).toFixed(2)}`;
  } else if (mode === "set_to") {
    ruleText = `Set price to $${n.toFixed(2)}`;
  }
  if (rounding !== "none" && ruleKind === "adjust") {
    const r = rounding === "end_99" ? ".99" : rounding === "end_95" ? ".95" : "whole dollar";
    ruleText += `, round to ${r}`;
  }
  if (ruleKind === "adjust" && compareAt !== "leave") {
    const c =
      compareAt === "sale" ? "move current price to compare-at" :
      compareAt === "clear" ? "clear compare-at" :
      compareAt === "percent" ? "adjust compare-at by same percent" :
      "adjust compare-at by same amount";
    ruleText += `, ${c}`;
  }

  let scopeText = "";
  if (scopeMode === "all") {
    scopeText = `All products (${totalVariants.toLocaleString()} variants)`;
  } else if (scopeMode === "specific") {
    const parts: string[] = [];
    if (pickedProducts.length > 0) parts.push(`${pickedProducts.length} product${pickedProducts.length === 1 ? "" : "s"}`);
    if (pickedVariants.length > 0) parts.push(`${pickedVariants.length} variant${pickedVariants.length === 1 ? "" : "s"}`);
    scopeText = parts.length > 0 ? parts.join(" + ") : "nothing picked";
  } else {
    const conj = conjunction === "OR" ? "any" : "all";
    scopeText = `Products matching ${conj} of ${conditions.length} condition${conditions.length === 1 ? "" : "s"}`;
  }

  return (
    <Box
      padding="400"
      borderWidth="025"
      borderColor="border"
      borderRadius="200"
      background="bg-surface-secondary"
    >
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">
          <Text as="span" fontWeight="semibold">Job:</Text> {title || "(untitled)"}
        </Text>
        <Text as="p" variant="bodyMd">
          <Text as="span" fontWeight="semibold">Rule:</Text> {ruleText}
        </Text>
        <Text as="p" variant="bodyMd">
          <Text as="span" fontWeight="semibold">Scope:</Text> {scopeText}
        </Text>
      </BlockStack>
    </Box>
  );
}

type ConditionFacets = {
  productTypes: string[];
  vendors: string[];
  tags: string[];
  variantTitles: string[];
  productTitles: string[];
  collections: Array<{ id: string; title: string }>;
};

/**
 * One row in the conditions list. Field + operator + value + delete.
 * Operator and value control dynamically update when the field changes.
 * Value control is chosen based on the field type and the available facets:
 * enumerable fields (vendor, type, tag, status, gift card, etc) get a
 * real Select populated from the store's own values when the operator is
 * "is" / "is not", and fall back to a TextField for partial-match operators.
 */
function ConditionRow({
  condition,
  onChange,
  onDelete,
  facets,
}: {
  condition: Condition;
  onChange: (patch: Partial<Condition>) => void;
  onDelete?: () => void;
  facets: ConditionFacets;
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

  // Pick the facet list for the currently-selected field. Text-kind fields
  // that have enumerable values get a Select; others fall through to a
  // TextField. "is" and "is_not" use the Select form; partial-match operators
  // (contains, starts_with, ends_with) use TextField because the value is not
  // necessarily one of the known facet values.
  const facetForField: string[] | null = (() => {
    switch (condition.field) {
      case "product_type": return facets.productTypes;
      case "vendor": return facets.vendors;
      case "tag": return facets.tags;
      case "variant_title": return facets.variantTitles;
      case "product_title": return facets.productTitles;
      default: return null;
    }
  })();
  const useFacetSelect =
    facetForField != null &&
    facetForField.length > 0 &&
    (condition.operator === "is" || condition.operator === "is_not");

  let valueControl: React.ReactNode;
  if (def.valueKind === "collection") {
    valueControl = (
      <Select
        label=""
        labelHidden
        options={[
          { label: "Select collection", value: "" },
          ...facets.collections.map((c) => ({ label: c.title, value: c.id })),
        ]}
        value={condition.value}
        onChange={(v) => onChange({ value: v })}
      />
    );
  } else if (def.valueKind === "status") {
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
        suffix="units"
      />
    );
  } else if (useFacetSelect && facetForField) {
    valueControl = (
      <Select
        label=""
        labelHidden
        options={[
          { label: `Select ${def.label.replace(/^The /, "").replace(/'s /, " ")}`, value: "" },
          ...facetForField.map((v) => ({ label: v, value: v })),
        ]}
        value={condition.value}
        onChange={(v) => onChange({ value: v })}
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

/**
 * Clickable card used in step 2 to pick between Sale and Custom price
 * adjustment. Highlights the selected tile with a brand-colored border.
 */
function RuleKindTile({
  selected,
  onClick,
  title,
  subtext,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtext: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        textAlign: "left",
        padding: 14,
        borderRadius: 10,
        cursor: "pointer",
        border: selected
          ? "2px solid var(--p-color-border-focus)"
          : "1px solid var(--p-color-border)",
        background: selected
          ? "var(--p-color-bg-surface-selected)"
          : "var(--p-color-bg-surface)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <Text as="span" variant="headingSm">{title}</Text>
      <Text as="span" variant="bodySm" tone="subdued">{subtext}</Text>
    </button>
  );
}

/**
 * Tiny product/variant thumbnail for the preview rows. Falls back to a soft
 * placeholder box when the product has no image at all.
 */
function Thumbnail({ src, alt }: { src: string | null; alt: string }) {
  const size = 40;
  if (!src) {
    return (
      <div
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          background: "var(--p-color-bg-surface-secondary)",
          border: "1px solid var(--p-color-border)",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "cover",
        borderRadius: 6,
        border: "1px solid var(--p-color-border)",
        flexShrink: 0,
      }}
    />
  );
}

/**
 * Paginated diff table used in the inline preview card below Step 3.
 * Shows current price, current compare-at, new price, new compare-at,
 * change percent, and any flag badge, with client-side pagination.
 */
function InlinePreviewTable({
  diffs,
  page,
  pageSize,
  onPageChange,
}: {
  diffs: PreviewDiff[];
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(diffs.length / pageSize));
  const pageStart = page * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, diffs.length);
  const pagedDiffs = diffs.slice(pageStart, pageEnd);
  const flagged = diffs.filter((d) => d.flags.length > 0).length;

  if (diffs.length === 0) {
    return (
      <Text as="p" variant="bodyMd" tone="subdued">
        No variants matched this rule. Try loosening your filter or adjusting the amount.
      </Text>
    );
  }

  const rows: Array<Array<React.ReactNode>> = pagedDiffs.map((d) => {
    const curPrice = d.before.price ?? "-";
    const curCompare = d.before.compareAtPrice ?? "-";
    const newPrice = d.after.price ?? "-";
    const newCompare = d.after.compareAtPrice ?? (d.before.compareAtPrice ? "cleared" : "-");
    const pct =
      d.pctChange == null
        ? "-"
        : `${d.pctChange > 0 ? "+" : ""}${d.pctChange.toFixed(1)}%`;
    const flag: React.ReactNode = d.flags.includes("big_drop") ? (
      <Badge tone="critical">big drop</Badge>
    ) : d.flags.includes("big_increase") ? (
      <Badge tone="warning">big increase</Badge>
    ) : (
      ""
    );
    const productCell = (
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <Thumbnail src={d.imageUrl} alt={d.productTitle || ""} />
        <Text as="span" variant="bodyMd">{d.productTitle || "-"}</Text>
      </InlineStack>
    );
    return [
      productCell,
      d.variantTitle || "-",
      curPrice,
      curCompare,
      newPrice,
      newCompare,
      pct,
      flag,
    ];
  });

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="center">
        <Text as="span" variant="headingSm">
          {`${diffs.length} variant${diffs.length === 1 ? "" : "s"} will change`}
        </Text>
        {flagged > 0 && <Badge tone="warning">{`${flagged} flagged`}</Badge>}
      </InlineStack>

      <DataTable
        columnContentTypes={[
          "text",
          "text",
          "numeric",
          "numeric",
          "numeric",
          "numeric",
          "numeric",
          "text",
        ]}
        headings={[
          "Product",
          "Variant",
          "Current price",
          "Current compare-at",
          "New price",
          "New compare-at",
          "Change",
          "Flag",
        ]}
        rows={rows}
        truncate
      />

      {diffs.length > pageSize && (
        <InlineStack gap="300" align="space-between" blockAlign="center">
          <Text as="p" tone="subdued" variant="bodySm">
            {`Showing ${pageStart + 1} to ${pageEnd} of ${diffs.length}`}
          </Text>
          <Pagination
            hasPrevious={page > 0}
            onPrevious={() => onPageChange(Math.max(0, page - 1))}
            hasNext={page < totalPages - 1}
            onNext={() => onPageChange(Math.min(totalPages - 1, page + 1))}
            label={`Page ${page + 1} of ${totalPages}`}
          />
        </InlineStack>
      )}
    </BlockStack>
  );
}

/**
 * Clickable scope card used in Step 3's card picker. Matches the elevated
 * card look with a subtle highlight when selected. Clicking it selects the
 * mode and collapses the picker to show the relevant flow.
 */
function ScopeCard({
  title,
  description,
  selected,
  onClick,
}: {
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <Box
        padding="400"
        borderWidth="025"
        borderColor={selected ? "border-emphasis" : "border"}
        borderRadius="200"
        background={selected ? "bg-surface-selected" : "bg-surface"}
      >
        <BlockStack gap="100">
          <Text as="h3" variant="headingSm">{title}</Text>
          <Text as="p" variant="bodyMd" tone="subdued">{description}</Text>
        </BlockStack>
      </Box>
    </div>
  );
}
