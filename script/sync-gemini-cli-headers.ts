import fs from "node:fs";
import path from "node:path";

/**
 * Syncs request headers from gemini-cli to our project.
 * Runs on build to ensure we stay in sync with the reference project.
 */
function syncHeaders() {
  const geminiCliCorePath = "gemini-cli/packages/core";
  const geminiCliPkgJsonPath = path.join(geminiCliCorePath, "package.json");

  if (!fs.existsSync(geminiCliPkgJsonPath)) {
    console.warn("Skipping header sync: Could not find gemini-cli package.json at", geminiCliPkgJsonPath);
    return;
  }

  const pkgJson = JSON.parse(fs.readFileSync(geminiCliPkgJsonPath, "utf-8"));
  const version = pkgJson.version;

  // Real gemini-cli User-Agent format from contentGenerator.ts:
  // `${userAgentPrefix}/${version}/${model} (${process.platform}; ${process.arch}; ${surface})`
  // We use gemini-2.5-pro as a placeholder for the sync.
  const platform = process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "x64" : "arm64";
  const userAgent = `GeminiCLI/${version}/gemini-2.5-pro (${platform}; ${arch}; terminal)`;

  // X-Goog-Api-Client alignment
  // Based on CHANGELOG.md, it's gl-node/{version}
  const xGoogApiClient = `gl-node/${process.versions.node}`;

  // Client-Metadata alignment
  // Based on CHANGELOG.md, it matches Gemini CLI's metadata structure.
  const clientMetadata = `ideType=GEMINI_CLI,platform=${platform.toUpperCase()}_${arch.toUpperCase()},pluginType=GEMINI`;

  const constantsPath = "src/constants.ts";
  const constantsTestPath = "src/constants.test.ts";

  if (fs.existsSync(constantsPath)) {
    let content = fs.readFileSync(constantsPath, "utf-8");
    
    // Update GEMINI_CLI_HEADERS in constants.ts
    const newHeaders = `export const GEMINI_CLI_HEADERS = {
  "User-Agent": "${userAgent}",
  "X-Goog-Api-Client": "${xGoogApiClient}",
  "Client-Metadata": "${clientMetadata}",
} as const;`;

    content = content.replace(
      /export const GEMINI_CLI_HEADERS = \{[\s\S]*?\} as const;/g,
      newHeaders
    );
    
    fs.writeFileSync(constantsPath, content);
    console.log(`Synced headers from Gemini CLI v${version}`);
  }

  // Update tests to match synced headers using regex for idempotency
  if (fs.existsSync(constantsTestPath)) {
    let content = fs.readFileSync(constantsTestPath, "utf-8");
    
    // Replace expectations in toEqual blocks
    // We only target the static expectations, not the dynamic ones.
    const staticUaRegex = /"User-Agent": "(?:google-api-nodejs-client\/9\.15\.1|GeminiCLI\/.*?\/gemini-2\.5-pro .*?)"/g;
    content = content.replace(staticUaRegex, `"User-Agent": "${userAgent}"`);

    const staticXGoogRegex = /"X-Goog-Api-Client": "(?:google-cloud-sdk vscode_cloudshelleditor\/0\.1|gl-node\/.*?)"/g;
    content = content.replace(staticXGoogRegex, `"X-Goog-Api-Client": "${xGoogApiClient}"`);

    const staticMetadataRegex = /"Client-Metadata": "(?:ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI|ideType=GEMINI_CLI,platform=.*?,pluginType=GEMINI)"/g;
    content = content.replace(staticMetadataRegex, `"Client-Metadata": "${clientMetadata}"`);

    fs.writeFileSync(constantsTestPath, content);
  }

  // Also update hardcoded User-Agent in quota.ts if it exists
  const quotaPath = "src/plugin/quota.ts";
  if (fs.existsSync(quotaPath)) {
    let content = fs.readFileSync(quotaPath, "utf-8");
    const quotaUserAgentRegex = /const geminiCliUserAgent = `GeminiCLI\/.*?`;/;
    const newQuotaUserAgent = `const geminiCliUserAgent = \`GeminiCLI/${version}/gemini-2.5-pro (\${platform}; \${arch})\`;`;
    
    if (quotaUserAgentRegex.test(content)) {
      content = content.replace(quotaUserAgentRegex, newQuotaUserAgent);
      fs.writeFileSync(quotaPath, content);
    }
  }
}

syncHeaders();
