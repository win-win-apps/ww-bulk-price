// App-wide constants
export const API_VERSION = "2025-01";
export const FREE_PLAN_PRODUCT_CAP = 100;
export const BATCH_SIZE = 50; // variants per productVariantsBulkUpdate call
export const MAX_PARALLEL_BATCHES = 3;
export const MAX_RETRIES = 6;
export const BASE_RETRY_MS = 500;

export const PLAN_NAMES = {
  FREE: "free",
  PRO: "pro",
} as const;

export const PRO_PRICE_USD = 4.99;
