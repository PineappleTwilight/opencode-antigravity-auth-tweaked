import { generatePKCE } from "@openauthjs/openauth/pkce";

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  getAntigravityHeaders,
  GEMINI_CLI_HEADERS,
} from "../constants";
import { createLogger } from "../plugin/logger";
import { calculateTokenExpiry, formatRefreshParts } from "../plugin/auth";
import {
  loadManagedProject,
  onboardManagedProject,
  getDefaultTierId,
  extractManagedProjectId,
} from "../plugin/project";

const log = createLogger("oauth");

interface PkcePair {
  challenge: string;
  verifier: string;
}

interface AntigravityAuthState {
  verifier: string;
  projectId: string;
}

/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface AntigravityAuthorization {
  url: string;
  verifier: string;
  projectId: string;
}

interface AntigravityTokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
  projectId: string;
}

interface AntigravityTokenExchangeFailure {
  type: "failed";
  error: string;
}

export type AntigravityTokenExchangeResult =
  | AntigravityTokenExchangeSuccess
  | AntigravityTokenExchangeFailure;

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface AntigravityUserInfo {
  email?: string;
}

/**
 * Encode an object into a URL-safe base64 string.
 */
function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode an OAuth state parameter back into its structured representation.
 */
function decodeState(state: string): AntigravityAuthState {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (typeof parsed.verifier !== "string") {
    throw new Error("Missing PKCE verifier in state");
  }
  return {
    verifier: parsed.verifier,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
  };
}

/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 */
export async function authorizeAntigravity(): Promise<AntigravityAuthorization> {
  const pkce = (await generatePKCE()) as PkcePair;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "state",
    encodeState({ verifier: pkce.verifier, projectId: "" }),
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId: "",
  };
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProjectID(accessToken: string): Promise<string> {
  // Environment variable takes highest precedence (matching Gemini CLI)
  const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (envProjectId) {
    console.log(`Using project ID from environment: ${envProjectId}`);
    log.debug("Using project ID from environment during OAuth", { envProjectId });
    return envProjectId;
  }

  try {
    console.log("Resolving Antigravity managed project...");
    // Try to resolve a managed project from Antigravity if possible.
    const loadPayload = await loadManagedProject(accessToken);
    let resolvedManagedProjectId = extractManagedProjectId(loadPayload);

    if (resolvedManagedProjectId) {
      console.log(`Resolved project: ${resolvedManagedProjectId}`);
      log.debug("Resolved managed project via loadCodeAssist", { resolvedManagedProjectId });
      return resolvedManagedProjectId;
    }

    // Try CLI-style resolution as a fallback
    console.log("Antigravity resolution failed, trying CLI fallback...");
    log.debug("Antigravity resolution failed, attempting CLI load fallback");
    const cliLoadPayload = await loadManagedProject(accessToken, undefined, true);
    resolvedManagedProjectId = extractManagedProjectId(cliLoadPayload);

    if (resolvedManagedProjectId) {
      console.log(`Resolved project via CLI fallback: ${resolvedManagedProjectId}`);
      log.debug("Resolved managed project via CLI load fallback", { resolvedManagedProjectId });
      return resolvedManagedProjectId;
    }

    // No managed project found - try to auto-provision one via onboarding.
    const tierId = getDefaultTierId(loadPayload?.allowedTiers || cliLoadPayload?.allowedTiers) ?? "FREE";
    console.log(`Auto-provisioning managed project (tier: ${tierId})...`);
    log.debug("Auto-provisioning managed project", { tierId });
    
    const provisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
    );

    if (provisionedProjectId) {
      console.log(`Successfully provisioned project: ${provisionedProjectId}`);
      log.debug("Successfully provisioned managed project", { provisionedProjectId });
      return provisionedProjectId;
    }

    // Try CLI-style onboarding as a fallback
    console.log("Antigravity provisioning failed, falling back to CLI onboarding...");
    log.debug("Antigravity provisioning failed, attempting CLI fallback");
    
    const cliProvisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
      undefined,
      true // useCliStyle
    );

    if (cliProvisionedProjectId) {
      console.log(`Successfully provisioned project via CLI fallback: ${cliProvisionedProjectId}`);
      log.debug("Successfully provisioned managed project via CLI fallback", { cliProvisionedProjectId });
      return cliProvisionedProjectId;
    }

    console.log("Warning: Failed to provision managed project - account may have limited access.");
    log.warn("Failed to provision managed project - account may not work correctly");
  } catch (error) {
    console.log(`Error during project discovery: ${error instanceof Error ? error.message : String(error)}`);
    log.warn("Error during project discovery/onboarding", { error: String(error) });
  }

  return "";
}

/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 */
export async function exchangeAntigravity(
  code: string,
  state: string,
): Promise<AntigravityTokenExchangeResult> {
  try {
    const { verifier, projectId } = decodeState(state);

    const startTime = Date.now();
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return { type: "failed", error: errorText };
    }

    const tokenPayload = (await tokenResponse.json()) as AntigravityTokenResponse;

    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      {
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
        },
      },
    );

    const userInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as AntigravityUserInfo)
      : {};

    const refreshToken = tokenPayload.refresh_token;
    if (!refreshToken) {
      return { type: "failed", error: "Missing refresh token in response" };
    }

    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
      effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
    }

    const storedRefresh = formatRefreshParts({
      refreshToken,
      projectId: effectiveProjectId || "",
      managedProjectId: effectiveProjectId || "",
    });

    return {
      type: "success",
      refresh: storedRefresh,
      access: tokenPayload.access_token,
      expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
      email: userInfo.email,
      projectId: effectiveProjectId || "",
    };
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
