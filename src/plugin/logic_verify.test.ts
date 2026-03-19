import { describe, it, expect, vi } from "vitest"
import { calculateBackoffMs } from "./accounts.ts"
import { selectHybridAccount, TokenBucketTracker } from "./rotation.ts"

describe("calculateBackoffMs jitter verification", () => {
  it("applies jitter to all reasons", () => {
    const reasons = ["QUOTA_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "MODEL_CAPACITY_EXHAUSTED", "SERVER_ERROR", "UNKNOWN"] as const
    
    for (const reason of reasons) {
      const samples = Array.from({ length: 100 }, () => calculateBackoffMs(reason, 0))
      const uniqueSamples = new Set(samples)
      // With Math.random(), 100 samples should almost certainly have many unique values
      expect(uniqueSamples.size).toBeGreaterThan(10)
      
      // Verify they are within ±15% range
      // We need to know the base values from the file
      let baseMs: number
      if (reason === "QUOTA_EXHAUSTED") baseMs = 60_000
      else if (reason === "RATE_LIMIT_EXCEEDED") baseMs = 30_000
      else if (reason === "MODEL_CAPACITY_EXHAUSTED") baseMs = 45_000
      else if (reason === "SERVER_ERROR") baseMs = 20_000
      else baseMs = 10_000
      
      const min = baseMs * 0.85
      const max = baseMs * 1.15
      
      for (const sample of samples) {
        expect(sample).toBeGreaterThanOrEqual(Math.floor(min))
        expect(sample).toBeLessThanOrEqual(Math.floor(max) + 1) // +1 for floating point / floor buffer
      }
    }
  })

  it("respects MIN_BACKOFF_MS", () => {
    // If we have a very small retryAfter, it should floor at 2000
    expect(calculateBackoffMs("UNKNOWN", 0, 500)).toBe(2000)
  })
})

describe("selectHybridAccount improved scoring", () => {
  const mockTokenTracker = {
    hasTokens: () => true,
    getTokens: () => 50,
    getMaxTokens: () => 50,
    getModelCost: () => 5
  } as unknown as TokenBucketTracker;

  it("prefers accounts with better quota health", () => {
    const accounts = [
      {
        index: 0,
        lastUsed: Date.now() - 1000,
        healthScore: 100,
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 0.2
      },
      {
        index: 1,
        lastUsed: Date.now() - 1000,
        healthScore: 100,
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 0.8
      }
    ];

    const selected = selectHybridAccount(accounts, mockTokenTracker);
    expect(selected).toBe(1); // Account 1 has better quota health
  });

  it("overrides conversation stickiness when advantage is over 500", () => {
    // Account 0 is the session match, but Account 1 is much healthier
    const accounts = [
      {
        index: 0,
        lastUsed: Date.now() - 3600000, // Used long ago
        healthScore: 60, // Poor health
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 0.1 // Almost no quota
      },
      {
        index: 1,
        lastUsed: Date.now() - 1000, // Fresh
        healthScore: 100, // Perfect health
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 1.0 // Full quota
      }
    ];

    // Calculate expected scores manually to verify threshold
    // Account 0: health(60*2=120) + tokens(500) + freshness(360) + quota(0.1*400=40) = 1020
    // Account 1: health(100*2=200) + tokens(500) + freshness(0.1) + quota(1.0*400=400) = 1100.1
    // Advantage: 1100.1 - 1020 = 80.1
    
    // Wait, I need a larger advantage to exceed 500.
    // Let's make Account 0 really bad.
    
    const accountsHighAdvantage = [
      {
        index: 0,
        lastUsed: Date.now() - 0, 
        healthScore: 50, 
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 0.0
      },
      {
        index: 1,
        lastUsed: Date.now() - 3600000, 
        healthScore: 100, 
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 1.0
      }
    ];
    // Acc 0: health(50*2=100) + tokens(500) + freshness(0) + quota(0) = 600
    // Acc 1: health(100*2=200) + tokens(500) + freshness(360) + quota(400) = 1460
    // Advantage: 1460 - 600 = 860 (> 500)

    const selected = selectHybridAccount(accountsHighAdvantage, mockTokenTracker, null, 0);
    expect(selected).toBe(1); // Switched away from session match because of high advantage
  });

  it("respects conversation stickiness when advantage is under 500", () => {
    const accountsLowAdvantage = [
      {
        index: 0,
        lastUsed: Date.now() - 1000,
        healthScore: 90,
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 0.8
      },
      {
        index: 1,
        lastUsed: Date.now() - 1000,
        healthScore: 100,
        isRateLimited: false,
        isCoolingDown: false,
        remainingQuotaFraction: 0.9
      }
    ];
    // Acc 0: health(180) + tokens(500) + freshness(0.1) + quota(320) = 1000.1
    // Acc 1: health(200) + tokens(500) + freshness(0.1) + quota(360) = 1060.1
    // Advantage: 60 (< 500)

    const selected = selectHybridAccount(accountsLowAdvantage, mockTokenTracker, null, 0);
    expect(selected).toBe(0); // Kept session match
  });
});
