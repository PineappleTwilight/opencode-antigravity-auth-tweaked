import {
  getAntigravityHeaders,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  GEMINI_CLI_HEADERS,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
import type { OAuthAuthDetails, ProjectContextResult } from "./types";

const log = createLogger("project");

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

const CODE_ASSIST_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
  pluginType: "GEMINI",
} as const;

interface AntigravityUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: {
    id?: string;
  };
  allowedTiers?: AntigravityUserTier[];
}

interface OnboardUserPayload {
  name?: string;
  done?: boolean;
  error?: {
    message: string;
    code: number;
    details?: any[];
  };
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

/**
 * Checks if an error in loadCodeAssist or onboardUser indicates validation is required.
 */
function isValidationRequired(data: any): { required: boolean; url?: string; message?: string } {
  if (data?.error?.details) {
    for (const detail of data.error.details) {
      if (detail.reason === "VALIDATION_REQUIRED" || detail.reason === "QUOTA_EXHAUSTED") {
        return { 
          required: true, 
          url: detail.metadata?.validation_url || detail.metadata?.verify_url,
          message: data.error.message 
        };
      }
    }
  }
  return { required: false };
}

/**
 * Polls a long-running operation until it is done.
 */
async function pollOperation(
  accessToken: string,
  baseEndpoint: string,
  operationName: string,
  maxAttempts = 12,
  delayMs = 5000,
): Promise<OnboardUserPayload | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...getAntigravityHeaders(),
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${baseEndpoint}/v1/${operationName}`, {
        headers,
      });

      if (!response.ok) {
        log.debug("Operation polling failed", { status: response.status, operationName });
        break;
      }

      const payload = (await response.json()) as OnboardUserPayload;
      if (payload.done) {
        return payload;
      }
    } catch (error) {
      log.debug("Error polling operation", { error: String(error), operationName });
      break;
    }
    await wait(delayMs);
  }
  return null;
}

function buildMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType,
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }
  return metadata;
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
export function getDefaultTierId(allowedTiers?: AntigravityUserTier[]): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) {
    return undefined;
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id;
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
export function extractManagedProjectId(payload: LoadCodeAssistPayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject;
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === "string") {
    return payload.cloudaicompanionProject.id;
  }
  return undefined;
}

/**
 * Generates a cache key for project context based on refresh token.
 */
function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
  useCliStyle = false,
): Promise<LoadCodeAssistPayload | null> {
  const metadata = useCliStyle 
    ? { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }
    : buildMetadata(projectId);
    
  const requestBody: Record<string, unknown> = { metadata };

  const loadHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    ... (useCliStyle ? GEMINI_CLI_HEADERS : {
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
    }),
  };

  const loadEndpoints = Array.from(
    new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]),
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      const response = await fetch(
        `${baseEndpoint}/v1internal:loadCodeAssist`,
        {
          method: "POST",
          headers: loadHeaders,
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        continue;
      }

      return (await response.json()) as LoadCodeAssistPayload;
    } catch (error) {
      log.debug("Failed to load managed project", { endpoint: baseEndpoint, error: String(error) });
      continue;
    }
  }

  return null;
}


/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  useCliStyle = false,
): Promise<string | undefined> {
  const metadata = useCliStyle 
    ? { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }
    : buildMetadata(projectId);

  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };

  const endpoints = Array.from(
    new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]),
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    ... (useCliStyle ? GEMINI_CLI_HEADERS : {
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
    }),
  };

  for (const baseEndpoint of endpoints) {
    try {
      log.debug("Attempting onboarding at endpoint", { baseEndpoint, useCliStyle });
      const response = await fetch(
        `${baseEndpoint}/v1internal:onboardUser`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        let errorData: any = {};
        try {
          errorData = JSON.parse(errorText);
        } catch {
          // not json
        }

        const validation = isValidationRequired(errorData);
        if (validation.required) {
          console.log(`\nAccount validation required: ${validation.message || "Please visit the URL below"}`);
          if (validation.url) {
            console.log(`URL: ${validation.url}\n`);
          }
          log.warn("Onboarding requires account validation", { url: validation.url });
        } else {
          log.debug("Onboarding request failed", { 
            status: response.status, 
            endpoint: baseEndpoint,
            error: errorText 
          });
        }
        continue;
      }

      let payload = (await response.json()) as OnboardUserPayload;
      
      // Handle long-running operations via polling
      if (!payload.done && payload.name) {
        log.debug("Onboarding started, polling operation", { name: payload.name });
        const result = await pollOperation(accessToken, baseEndpoint, payload.name);
        if (result) {
          payload = result;
        }
      }

      const managedProjectId = payload.response?.cloudaicompanionProject?.id;
      if (payload.done && managedProjectId) {
        return managedProjectId;
      }
      if (payload.done && projectId) {
        return projectId;
      }
    } catch (error) {
      log.debug("Failed to onboard managed project", { endpoint: baseEndpoint, error: String(error) });
      continue;
    }
  }

  return undefined;
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult> {
  const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: envProjectId || "" };
  }

  const cacheKey = getCacheKey(auth);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh);
    
    // Environment variable takes highest precedence (matching Gemini CLI)
    if (envProjectId) {
      log.debug("Using project ID from environment", { envProjectId });
      return { auth, effectiveProjectId: envProjectId };
    }

    if (parts.managedProjectId) {
      return { auth, effectiveProjectId: parts.managedProjectId };
    }

    const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
    const persistManagedProject = async (managedProjectId: string): Promise<ProjectContextResult> => {
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
        }),
      };

      return { auth: updatedAuth, effectiveProjectId: managedProjectId };
    };

    // Try to resolve a managed project from Antigravity if possible.
    const loadPayload = await loadManagedProject(accessToken, parts.projectId ?? fallbackProjectId);
    let resolvedManagedProjectId = extractManagedProjectId(loadPayload);

    if (resolvedManagedProjectId) {
      return persistManagedProject(resolvedManagedProjectId);
    }

    // Try CLI-style load as a fallback
    log.debug("Antigravity load failed, attempting CLI load fallback", { projectId: parts.projectId });
    const cliLoadPayload = await loadManagedProject(
      accessToken,
      parts.projectId ?? fallbackProjectId,
      true // useCliStyle
    );
    resolvedManagedProjectId = extractManagedProjectId(cliLoadPayload);

    if (resolvedManagedProjectId) {
      log.debug("Successfully resolved managed project via CLI load fallback", { resolvedManagedProjectId });
      return persistManagedProject(resolvedManagedProjectId);
    }

    // No managed project found - try to auto-provision one via onboarding.
    // Use the allowed tiers from whichever load response we got (preferring Antigravity)
    const tierId = getDefaultTierId(loadPayload?.allowedTiers || cliLoadPayload?.allowedTiers) ?? "FREE";
    log.debug("Auto-provisioning managed project", { tierId, projectId: parts.projectId });
    
    const provisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
      parts.projectId,
    );

    if (provisionedProjectId) {
      log.debug("Successfully provisioned managed project", { provisionedProjectId });
      return persistManagedProject(provisionedProjectId);
    }

    // Try CLI-style onboarding as a fallback
    log.debug("Antigravity provisioning failed, attempting CLI fallback", { tierId, projectId: parts.projectId });
    const cliProvisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
      parts.projectId,
      true // useCliStyle
    );

    if (cliProvisionedProjectId) {
      log.debug("Successfully provisioned managed project via CLI fallback", { cliProvisionedProjectId });
      return persistManagedProject(cliProvisionedProjectId);
    }

    log.warn("Failed to provision managed project - account may not work correctly", {
      hasProjectId: !!parts.projectId,
    });

    if (parts.projectId) {
      return { auth, effectiveProjectId: parts.projectId };
    }

    // No project id present in auth; fall back to the hardcoded id for requests.
    return { auth, effectiveProjectId: fallbackProjectId };
  };

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }
      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}
