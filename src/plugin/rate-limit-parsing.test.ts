import { describe, it, expect } from "vitest";
import { parseRateLimitReason } from "./accounts";

// Simulate the extractRateLimitBodyInfo logic from plugin.ts
function extractRateLimitBodyInfo(body: unknown, rawBody?: string) {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null as number | null, rawBody };
  }

  let error: unknown = undefined;
  let directMessage: string | undefined = undefined;

  const errorProp = (body as { error?: unknown }).error;
  if (errorProp) {
    error = errorProp;
  } else {
    directMessage = (body as { message?: string }).message;
  }

  const message = (error && typeof error === "object"
    ? (error as { message?: string }).message
    : directMessage) || undefined;

  const details = error && typeof error === "object"
    ? (error as { details?: unknown[] }).details
    : undefined;

  let reason: string | undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = (detail as { reason?: string }).reason;
        if (typeof detailReason === "string") {
          reason = detailReason;
          break;
        }
      }
    }
  }

  return { retryDelayMs: null, message, reason, rawBody };
}

function extractRetryInfoFromBody(text: string) {
  try {
    let parsed = JSON.parse(text) as unknown;
    
    // Handle case where response is wrapped in an array (SSE stream or batched response)
    if (Array.isArray(parsed) && parsed.length > 0) {
      parsed = parsed[0];
    }
    
    const info = extractRateLimitBodyInfo(parsed);
    return { ...info, rawBody: text };
  } catch {
    return { retryDelayMs: null as number | null, message: text.trim() || undefined, rawBody: text };
  }
}

async function extractRetryInfoFromResponse(response: Response): Promise<{ retryDelayMs: number | null; message?: string; reason?: string; rawBody?: string }> {
  try {
    const text = await response.clone().text();
    try {
      let parsed = JSON.parse(text) as unknown;
      
      // Handle case where response is wrapped in an array (SSE stream or batched response)
      if (Array.isArray(parsed) && parsed.length > 0) {
        parsed = parsed[0];
      }
      
      const info = extractRateLimitBodyInfo(parsed);
      return { ...info, rawBody: text };
    } catch {
      // JSON parsing failed, but text might contain a plain error message
      return { retryDelayMs: null, message: text.trim() || undefined, rawBody: text };
    }
  } catch {
    return { retryDelayMs: null };
  }
}

describe("Rate Limit Parsing - Quota Exhausted", () => {
  it("should extract message from array-wrapped response with exhausted capacity", () => {
    const responseBody = `[{
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.",
    "errors": [
      {
        "message": "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.",
        "domain": "global",
        "reason": "rateLimitExceeded"
      }
    ],
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "uiMessage": "true",
          "model": "gemini-3-flash-preview"
        }
      }
    ]
  }
}]`;

    const bodyInfo = extractRetryInfoFromBody(responseBody);
    
    expect(bodyInfo.message).toBeDefined();
    expect(bodyInfo.message).toContain("exhausted your capacity");
    expect(bodyInfo.reason).toBe("QUOTA_EXHAUSTED");
  });

  it("should classify exhausted capacity as QUOTA_EXHAUSTED", () => {
    const message = "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.";
    const reason = parseRateLimitReason("QUOTA_EXHAUSTED", message, 429);
    expect(reason).toBe("QUOTA_EXHAUSTED");
  });

  it("should classify message with exhausted as QUOTA_EXHAUSTED even without reason field", () => {
    const message = "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.";
    const reason = parseRateLimitReason(undefined, message, 429);
    expect(reason).toBe("QUOTA_EXHAUSTED");
  });

  it("should extract message from non-array response", () => {
    const responseBody = `{
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model.",
    "status": "RESOURCE_EXHAUSTED"
  }
}`;

    const bodyInfo = extractRetryInfoFromBody(responseBody);
    
    expect(bodyInfo.message).toBeDefined();
    expect(bodyInfo.message).toContain("exhausted your capacity");
  });

  it("should handle message with quota keyword", () => {
    const message = "Your quota has been exhausted.";
    const reason = parseRateLimitReason(undefined, message, 429);
    expect(reason).toBe("QUOTA_EXHAUSTED");
  });

  it("should NOT classify pure capacity issues as quota exhausted", () => {
    const message = "Capacity is currently unavailable. Please try again later.";
    const reason = parseRateLimitReason(undefined, message, 429);
    expect(reason).toBe("MODEL_CAPACITY_EXHAUSTED");
  });

  it("should classify rate limit as RATE_LIMIT_EXCEEDED", () => {
    const message = "Rate limit exceeded. Too many requests per minute.";
    const reason = parseRateLimitReason(undefined, message, 429);
    expect(reason).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("should extract message from actual Response object (array-wrapped)", async () => {
    const responseBody = `[{
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.",
    "errors": [
      {
        "message": "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.",
        "domain": "global",
        "reason": "rateLimitExceeded"
      }
    ],
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "uiMessage": "true",
          "model": "gemini-3-flash-preview"
        }
      }
    ]
  }
}]`;

    const response = new Response(responseBody, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });

    const bodyInfo = await extractRetryInfoFromResponse(response);
    
    expect(bodyInfo.message).toBeDefined();
    expect(bodyInfo.message).toContain("exhausted your capacity");
    expect(bodyInfo.reason).toBe("QUOTA_EXHAUSTED");
  });

  it("should extract message from actual Response object (non-array)", async () => {
    const responseBody = `{
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model. Your quota will reset after 15h34m4s.",
    "status": "RESOURCE_EXHAUSTED"
  }
}`;

    const response = new Response(responseBody, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });

    const bodyInfo = await extractRetryInfoFromResponse(response);
    
    expect(bodyInfo.message).toBeDefined();
    expect(bodyInfo.message).toContain("exhausted your capacity");
  });
});
