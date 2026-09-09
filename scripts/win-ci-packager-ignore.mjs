/**
 * Fast packager ignore for Windows CI: skip most of node_modules without calling
 * the full forge ignore() on every nested file.
 */

/** Top-level node_modules paths that may be copied (must match forge.config.ts allowlist). */
const ALLOWED_NODE_MODULE_PREFIXES = [
  "/node_modules/stacktrace-js",
  "/node_modules/html-to-image",
  "/node_modules/better-sqlite3",
  "/node_modules/keytar",
  "/node_modules/web-tree-sitter",
  "/node_modules/tree-sitter-wasms",
  "/node_modules/tiktoken",
  "/node_modules/unpdf",
  "/node_modules/@anthropic-ai/tokenizer",
  "/node_modules/geist/dist",
  "/node_modules/bindings",
  "/node_modules/file-uri-to-path",
];

function isAllowedNodeModulesPath(file) {
  if (file === "/node_modules") return true;
  if (!file.startsWith("/node_modules/")) return false;
  if (
    process.env.ATLARIX_BUNDLE_GIT === "1" &&
    file.startsWith("/node_modules/dugite")
  ) {
    return true;
  }
  if (
    process.env.E2E_TEST_BUILD === "true" &&
    file.startsWith("/node_modules/dugite")
  ) {
    return true;
  }
  return ALLOWED_NODE_MODULE_PREFIXES.some(
    (p) => file === p || file.startsWith(`${p}/`),
  );
}

/** Paths that must never be copied into resources/app (avoid self-copy when tmpdir is under repo). */
function isWorkspaceMetaPath(file) {
  if (file === "/.cache" || file.startsWith("/.cache/")) return true;
  if (file === "/out" || file.startsWith("/out/")) return true;
  return false;
}

function isRequiredAppRootFile(file) {
  return file === "/package.json";
}

/**
 * @param {(file: string) => boolean} forgeIgnore from forge.config packagerConfig.ignore
 * @returns {(file: string) => boolean}
 */
export function createFastPackagerIgnore(forgeIgnore) {
  return (file) => {
    if (!file) return false;
    if (isWorkspaceMetaPath(file)) return true;
    if (isRequiredAppRootFile(file)) return false;
    if (file.startsWith("/node_modules")) {
      if (!isAllowedNodeModulesPath(file)) return true;
      return forgeIgnore(file);
    }
    return forgeIgnore(file);
  };
}

/**
 * @param {((file: string) => boolean) | RegExp | (string | RegExp)[]} ignore
 * @returns {(file: string) => boolean}
 */
export function wrapPackagerIgnore(ignore) {
  if (typeof ignore === "function") {
    return (file) => {
      if (!file) return false;
      if (isWorkspaceMetaPath(file)) return true;
      if (isRequiredAppRootFile(file)) return false;
      return ignore(file);
    };
  }
  return ignore;
}
