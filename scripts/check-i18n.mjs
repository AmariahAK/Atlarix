#!/usr/bin/env node
/**
 * i18n guards that TypeScript cannot express.
 *
 * Three jobs, in increasing order of how much they will annoy you:
 *
 * 1. CATALOG PARITY — every non-English catalog has exactly the English key set,
 *    and every ICU placeholder in a translation also appears in its English
 *    source. A translator dropping `{{count}}` is not a cosmetic problem: the
 *    interpolation renders empty and the sentence becomes wrong.
 *
 * 2. RTL REFUSAL — SUPPORTED_LOCALES must stay left-to-right. All 13 are, which
 *    is why there is no bidi handling anywhere and ~77 physical ml-/mr- classes
 *    are considered fine. Adding an RTL locale without that work would break
 *    layout everywhere, silently, for only those users.
 *
 * 3. THE HARDCODED-STRING RATCHET — a committed baseline count that may only go
 *    DOWN. Deliberately a ratchet rather than a wall: the migration lands surface
 *    by surface over many PRs, and a wall would be red for the whole of it, which
 *    means it would be switched off. Same doctrine as the prompt-budget ceilings.
 *
 * Runs as a standalone node script wired to `npm run check:i18n`, matching
 * `check-sandbox-helpers.mjs` and `verify-ban-guard.mjs`, rather than standing up
 * a second linter alongside oxlint purely for `no-literal-string`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES_DIR = path.join(ROOT, "src/lib/i18n/locales");
const BASELINE_FILE = path.join(ROOT, "scripts/i18n-baseline.json");
const TAG = "check-i18n";

let failed = false;
const fail = (msg) => {
  console.error(`${process.env.CI ? "::error::" : ""}[${TAG}] ${msg}`);
  failed = true;
};

// ── 1. RTL refusal ──────────────────────────────────────────────────────────
const localesSrc = fs.readFileSync(
  path.join(ROOT, "src/lib/i18n/locales.ts"),
  "utf8",
);
const supported = [
  ...localesSrc
    .slice(
      localesSrc.indexOf("export const SUPPORTED_LOCALES = ["),
      localesSrc.indexOf("] as const"),
    )
    .matchAll(/"([a-z-]+)"/g),
].map((m) => m[1]);

if (supported.length === 0) fail("could not parse SUPPORTED_LOCALES");
const RTL = ["ar", "he", "fa", "ur", "yi", "dv", "ps"];
for (const l of supported) {
  if (RTL.includes(l.split("-")[0])) {
    fail(
      `"${l}" is a right-to-left locale. The app has no bidi handling and ~77 ` +
        `physical ml-/mr- classes — adding it needs that work first, not this ` +
        `assertion deleted.`,
    );
  }
}

// ── 2. Catalog parity ───────────────────────────────────────────────────────
const keysOf = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? keysOf(v, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
const valuesOf = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? valuesOf(v, `${prefix}${k}.`)
      : [[`${prefix}${k}`, String(v)]],
  );
const placeholders = (s) =>
  [...s.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]).sort();

const readCatalog = (locale, ns) => {
  const f = path.join(LOCALES_DIR, locale, `${ns}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    fail(`${locale}/${ns}.json is not valid JSON: ${e.message}`);
    return null;
  }
};

const enDir = path.join(LOCALES_DIR, "en-us");
const namespaces = fs.existsSync(enDir)
  ? fs
      .readdirSync(enDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
  : [];
if (namespaces.length === 0) fail("no English catalogs found");

let compared = 0;
for (const locale of supported) {
  if (locale === "en-us") continue;
  if (!fs.existsSync(path.join(LOCALES_DIR, locale))) continue; // not translated yet
  for (const ns of namespaces) {
    const en = readCatalog("en-us", ns);
    const other = readCatalog(locale, ns);
    if (!en || !other) continue;
    compared++;
    const enKeys = new Set(keysOf(en));
    const otherKeys = new Set(keysOf(other));
    for (const k of enKeys) {
      if (!otherKeys.has(k)) fail(`${locale}/${ns}.json is missing key "${k}"`);
    }
    for (const k of otherKeys) {
      if (!enKeys.has(k)) fail(`${locale}/${ns}.json has orphan key "${k}"`);
    }
    const enVals = new Map(valuesOf(en));
    for (const [k, v] of valuesOf(other)) {
      if (!v.trim()) fail(`${locale}/${ns}.json has an empty value for "${k}"`);
      const src = enVals.get(k);
      if (src === undefined) continue;
      const a = placeholders(src).join(",");
      const b = placeholders(v).join(",");
      if (a !== b) {
        fail(
          `${locale}/${ns}.json "${k}" placeholders differ (en: [${a}] vs [${b}]) — ` +
            `a dropped {{…}} renders empty and makes the sentence wrong`,
        );
      }
    }
  }
}

// ── 3. Hardcoded-string ratchet ─────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * Count JSX text runs that look like prose a user reads.
 *
 * Deliberately crude and deliberately CONSISTENT — the number only has to be
 * comparable with itself. Requires two words and a letter, which skips `{...}`
 * expressions, single-word class-ish tokens, punctuation and numerals.
 */
const PROSE = />(\s*[A-Z][A-Za-z]+(?:[ ,'’-][A-Za-z]+)+[.?!]?\s*)</g;
const files = fs.existsSync(path.join(ROOT, "src/components"))
  ? [
      ...walk(path.join(ROOT, "src/components")),
      ...walk(path.join(ROOT, "src/pages")),
    ]
  : [];
let hardcoded = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  hardcoded += [...src.matchAll(PROSE)].length;
}

const baseline = fs.existsSync(BASELINE_FILE)
  ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")).hardcodedJsxStrings
  : null;

if (baseline == null) {
  console.log(`[${TAG}] no baseline — writing ${hardcoded}`);
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ hardcodedJsxStrings: hardcoded }, null, 2)}\n`,
  );
} else if (hardcoded > baseline) {
  fail(
    `hardcoded JSX strings went UP: ${hardcoded} vs baseline ${baseline}. ` +
      `Use t("…") for new user-facing text. This is a ratchet — it only goes down.`,
  );
} else if (hardcoded < baseline) {
  console.log(
    `[${TAG}] ratchet tightens: ${hardcoded} (was ${baseline}) — updating baseline`,
  );
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ hardcodedJsxStrings: hardcoded }, null, 2)}\n`,
  );
}

if (failed) process.exit(1);
console.log(
  `[${TAG}] OK — ${supported.length} locales, ${namespaces.length} namespaces, ` +
    `${compared} catalog(s) compared, ${hardcoded} hardcoded JSX strings`,
);
