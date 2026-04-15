// Custom error classes
export class APIRateLimitError extends Error {
  currentlyAvailable?: number;
  actualQueryCost?: number;
  refreshRate?: number;
  constructor(message: string, cost?: { currentlyAvailable?: number; actualQueryCost?: number; refreshRate?: number }) {
    super(message);
    this.name = "APIRateLimitError";
    if (cost) {
      this.currentlyAvailable = cost.currentlyAvailable;
      this.actualQueryCost = cost.actualQueryCost;
      this.refreshRate = cost.refreshRate;
    }
  }
}

export class UserVisibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserVisibleError";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
