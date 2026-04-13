/**
 * Smoke test: native tree-sitter + TypeScript grammar load and parse (host Node / CI).
 * Does not substitute for Electron ABI rebuild verification after `electron-forge package`.
 */

const Parser = require("tree-sitter");
const { typescript } = require("tree-sitter-typescript");

const parser = new Parser();
parser.setLanguage(typescript);
const tree = parser.parse("export const __smoke = 1;\n");
if (!tree.rootNode || tree.rootNode.namedChildCount < 1) {
  console.error("smoke-tree-sitter: expected at least one named child on root");
  process.exit(1);
}
console.log("smoke-tree-sitter: ok");
