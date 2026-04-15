import { APIRateLimitError, sleep } from "./errors";
import { MAX_RETRIES, BASE_RETRY_MS } from "./constants";

// Wrap any async Shopify API call with exponential backoff on rate limit
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof APIRateLimitError && attempt < maxRetries - 1) {
        attempt += 1;
        const delay = BASE_RETRY_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}
