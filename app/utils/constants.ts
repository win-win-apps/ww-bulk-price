// App-wide constants
export const API_VERSION = "2025-01";
// Hard safety ceiling on variants per single apply run. This is not a paywall,
// it's a guard rail so one over-eager run doesn't blow up the merchant's store
// or our Shopify API rate limits. 5000 variants covers 99% of stores in one shot.
export const MAX_VARIANTS_PER_APPLY = 5000;
export const BATCH_SIZE = 50; // variants per productVariantsBulkUpdate call
export const MAX_PARALLEL_BATCHES = 3;
export const MAX_RETRIES = 6;
export const BASE_RETRY_MS = 500;
