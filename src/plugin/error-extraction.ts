import { createLogger } from "./logger"

const log = createLogger("error-extraction")

export function decodeEscapedText(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

export function normalizeGoogleVerificationUrl(rawUrl: string): string | undefined {
  const normalized = decodeEscapedText(rawUrl).trim()
  if (!normalized) {
    return undefined
  }
  try {
    const parsed = new URL(normalized)
    if (parsed.hostname !== "accounts.google.com") {
      return undefined
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

export function selectBestVerificationUrl(urls: string[]): string | undefined {
  const unique = Array.from(new Set(urls.map((url) => normalizeGoogleVerificationUrl(url)).filter(Boolean) as string[]))
  if (unique.length === 0) {
    return undefined
  }
  unique.sort((a, b) => {
    const score = (value: string): number => {
      let total = 0
      if (value.includes("plt=")) total += 4
      if (value.includes("/signin/continue")) total += 3
      if (value.includes("continue=")) total += 2
      if (value.includes("service=cloudcode")) total += 1
      return total
    }
    return score(b) - score(a)
  })
  return unique[0]
}

export function extractVerificationErrorDetails(bodyText: string): {
  validationRequired: boolean
  message?: string
  verifyUrl?: string
} {
  const decodedBody = decodeEscapedText(bodyText)
  const lowerBody = decodedBody.toLowerCase()
  let validationRequired = lowerBody.includes("validation_required")
  let message: string | undefined
  const verificationUrls = new Set<string>()

  const collectUrlsFromText = (text: string): void => {
    for (const match of text.matchAll(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi)) {
      if (match[0]) {
        verificationUrls.add(match[0])
      }
    }
  }

  collectUrlsFromText(decodedBody)

  const payloads: unknown[] = []
  const trimmed = decodedBody.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      payloads.push(JSON.parse(trimmed))
    } catch {
    }
  }

  for (const rawLine of decodedBody.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("data:")) {
      continue
    }
    const payloadText = line.slice(5).trim()
    if (!payloadText || payloadText === "[DONE]") {
      continue
    }
    try {
      payloads.push(JSON.parse(payloadText))
    } catch {
      collectUrlsFromText(payloadText)
    }
  }

  const visited = new Set<unknown>()
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      const normalizedValue = decodeEscapedText(value)
      const lowerKey = key?.toLowerCase() ?? ""

      if (normalizedValue.toLowerCase().includes("validation_required")) {
        validationRequired = true
      }
      if (
        !message &&
        (lowerKey.includes("message") || lowerKey.includes("detail") || lowerKey.includes("description"))
      ) {
        message = normalizedValue
      }
      if (
        lowerKey.includes("validation_url") ||
        lowerKey.includes("verify_url") ||
        lowerKey.includes("verification_url") ||
        lowerKey === "url"
      ) {
        verificationUrls.add(normalizedValue)
      }
      collectUrlsFromText(normalizedValue)
      return
    }

    if (!value || typeof value !== "object" || visited.has(value)) {
      return
    }

    visited.add(value)

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item)
      }
      return
    }

    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      walk(childValue, childKey)
    }
  }

  for (const payload of payloads) {
    walk(payload)
  }

  if (!validationRequired) {
    validationRequired =
      lowerBody.includes("verification required") ||
      lowerBody.includes("verify your account") ||
      lowerBody.includes("account verification")
  }

  if (!message) {
    const fallback = decodedBody
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("data:") && /(verify|validation|required)/i.test(line))
    if (fallback) {
      message = fallback
    }
  }

  return {
    validationRequired,
    message,
    verifyUrl: selectBestVerificationUrl([...verificationUrls]),
  }
}

export function parseDurationToMs(duration: string): number | null {
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i)
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!)
    const unit = (simpleMatch[2] || "s").toLowerCase()
    switch (unit) {
      case "h": return value * 3600 * 1000
      case "m": return value * 60 * 1000
      case "s": return value * 1000
      case "ms": return value
      default: return value * 1000
    }
  }
  
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi
  let totalMs = 0
  let matchFound = false
  let match
  
  while ((match = compoundRegex.exec(duration)) !== null) {
    matchFound = true
    const value = parseFloat(match[1]!)
    const unit = match[2]!.toLowerCase()
    switch (unit) {
      case "h": totalMs += value * 3600 * 1000; break
      case "m": totalMs += value * 60 * 1000; break
      case "s": totalMs += value * 1000; break
      case "ms": totalMs += value; break
    }
  }
  
  return matchFound ? totalMs : null
}

export interface RateLimitBodyInfo {
  retryDelayMs: number | null
  message?: string
  quotaResetTime?: string
  reason?: string
  rawBody?: string
}

export function extractRateLimitBodyInfo(body: unknown, rawBody?: string): RateLimitBodyInfo {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null, rawBody }
  }

  let error: unknown = undefined
  let directMessage: string | undefined = undefined

  const errorProp = (body as { error?: unknown }).error
  if (errorProp && typeof errorProp === "object") {
    error = errorProp
  } else {
    directMessage = (body as { message?: string }).message
  }

  const message = (error && typeof error === "object"
    ? (error as { message?: string }).message
    : directMessage) || undefined

  const details = error && typeof error === "object"
    ? (error as { details?: unknown[] }).details
    : undefined

  let reason: string | undefined
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue
      const type = (detail as { "@type"?: string })["@type"]
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = (detail as { reason?: string }).reason
        if (typeof detailReason === "string") {
          reason = detailReason
          break
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue
      const type = (detail as { "@type"?: string })["@type"]
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationToMs(retryDelay)
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason, rawBody }
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue
      const metadata = (detail as { metadata?: Record<string, string> }).metadata
      if (metadata && typeof metadata === "object") {
        const quotaResetDelay = metadata.quotaResetDelay
        const quotaResetTime = metadata.quotaResetTimeStamp
        if (typeof quotaResetDelay === "string") {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay)
          if (quotaResetDelayMs !== null) {
            return { retryDelayMs: quotaResetDelayMs, message, quotaResetTime, reason, rawBody }
          }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i)
    const rawDuration = afterMatch?.[1]
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration)
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason, rawBody }
      }
    }
  }

  return { retryDelayMs: null, message, reason, rawBody }
}

export async function extractRetryInfoFromBody(response: Response): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text()
    
    if (!text || text.trim() === "") {
      return { retryDelayMs: null, rawBody: text }
    }
    
    try {
      let parsed = JSON.parse(text) as unknown
      
      if (Array.isArray(parsed) && parsed.length > 0) {
        parsed = parsed[0]
      }
      
      const info = extractRateLimitBodyInfo(parsed)
      return { ...info, rawBody: text }
    } catch (parseError) {
      return { retryDelayMs: null, message: text.trim() || undefined, rawBody: text }
    }
  } catch (readError) {
    return { retryDelayMs: null }
  }
}

export function extractMessageFromRawBody(rawBody: string): string | undefined {
  if (!rawBody || rawBody.trim() === "") return undefined
  
  const messageMatch = rawBody.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/i)
  if (messageMatch && messageMatch[1]) {
    return messageMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  
  return undefined
}

export function retryAfterMsFromResponse(response: Response, defaultRetryMs: number = 60_000): number {
  const retryAfterMsHeader = response.headers.get("retry-after-ms")
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }

  const retryAfterHeader = response.headers.get("retry-after")
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000
    }
  }

  return defaultRetryMs
}
