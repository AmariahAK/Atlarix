/**
 * n8n Credential Loader - Fetches & parses credential definitions from n8n-io/n8n
 * Auto-generates env vars from properties; heuristic package inference.
 * No hardcoding: source of truth is n8n's GitHub repo.
 */

const N8N_CREDENTIALS_BASE =
  "https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/credentials";

export interface ParsedCredential {
  name: string;
  displayName: string;
  envVars: string[];
  package: string | null;
  integration: string | null;
}

const credentialCache = new Map<string, ParsedCredential | null>();

/** Credential name → PascalCase filename (stripeApi → StripeApi) */
function credNameToFileName(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .split(/[\s_-]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join("");
}

/** Convert to env var format: stripeApi_secretKey → STRIPE_API_SECRET_KEY */
function toEnvVar(credName: string, propName: string): string {
  const prefix = credName.replace(/([A-Z])/g, "_$1").toUpperCase().replace(/^_/, "");
  const prop = propName.replace(/([A-Z])/g, "_$1").toUpperCase().replace(/^_/, "");
  return prefix + "_" + prop;
}

/** Heuristic: credential name → npm package. Fallback when no explicit mapping. */
function inferPackage(credName: string): string | null {
  const lower = credName.toLowerCase();
  const special: Record<string, string> = {
    stripeapi: "stripe",
    stripeoauth2api: "stripe",
    postgres: "pg",
    postgresql: "pg",
    mysql: "mysql2",
    mongodb: "mongodb",
    redis: "ioredis",
    sendgridapi: "@sendgrid/mail",
    twilioapi: "twilio",
    openaiapi: "openai",
    slackapi: "@slack/web-api",
    airtableapi: "airtable",
    airtabletokenapi: "airtable",
    githuboauth2api: "@octokit/rest",
    notionapi: "@notionhq/client",
    hubspotapi: "@hubspot/api-client",
    salesforceoauth2api: "jsforce",
    telegramapi: "node-telegram-bot-api",
    discordbotapi: "discord.js",
    dropboxoauth2api: "dropbox",
    aws: "@aws-sdk/client-s3",
    supabaseapi: "@supabase/supabase-js",
    zoomoauth2api: "@zoom/meetingsdk",
  };
  if (special[lower]) return special[lower];
  const base = credName.replace(/api$|oauth2api$|tokenapi$/i, "");
  if (!base) return null;
  const kebab = base.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
  return kebab || null;
}

/** Parse credential TS file: extract name, properties (skip notice type) */
function parseCredentialContent(content: string): { name: string; displayName: string; propNames: string[] } | null {
  const nameMatch = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  const displayMatch = content.match(/displayName\s*=\s*['"]([^'"]+)['"]/);
  const displayName = displayMatch ? displayMatch[1] : name;

  const propNames: string[] = [];
  const skipTypes = new Set(["notice"]);
  const blockRegex = /\{\s*displayName:[\s\S]+?name:\s*['"]([^'"]+)['"][\s\S]+?type:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = blockRegex.exec(content)) !== null) {
    if (!skipTypes.has(m[2])) propNames.push(m[1]);
  }
  if (propNames.length === 0) {
    const altRegex = /name:\s*['"]([^'"]+)['"][\s\S]+?type:\s*['"](string|number|password|boolean)['"]/g;
    while ((m = altRegex.exec(content)) !== null) {
      propNames.push(m[1]);
    }
  }
  return { name, displayName, propNames };
}

/**
 * Fetch and parse a credential definition from n8n's GitHub repo.
 * Returns env vars (auto-generated from properties) and inferred package.
 */
export async function getCredentialDefinition(
  credName: string
): Promise<ParsedCredential | null> {
  const cached = credentialCache.get(credName);
  if (cached !== undefined) return cached;

  const fileName = credNameToFileName(credName);
  const url = `${N8N_CREDENTIALS_BASE}/${fileName}.credentials.ts`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) {
      credentialCache.set(credName, null);
      return null;
    }
    const content = await res.text();
    const parsed = parseCredentialContent(content);
    if (!parsed) {
      credentialCache.set(credName, null);
      return null;
    }

    const envVars =
      parsed.propNames.length > 0
        ? parsed.propNames.map((p) => toEnvVar(parsed.name, p))
        : [`${parsed.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];

    const pkg = inferPackage(parsed.name);
    const integration = parsed.displayName || null;

    const result: ParsedCredential = {
      name: parsed.name,
      displayName: parsed.displayName,
      envVars,
      package: pkg,
      integration,
    };
    credentialCache.set(credName, result);
    return result;
  } catch {
    credentialCache.set(credName, null);
    return null;
  }
}

/**
 * Get credential mapping for workflow stack (env + package + integration).
 * Uses n8n source when available; fallback to heuristic.
 */
export async function getCredentialMapping(credName: string): Promise<{
  env: string[];
  package: string | null;
  integration: string | null;
}> {
  const def = await getCredentialDefinition(credName);
  if (def) {
    return {
      env: def.envVars,
      package: def.package,
      integration: def.integration,
    };
  }
  return {
    env: [`${credName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`],
    package: inferPackage(credName),
    integration: null,
  };
}
