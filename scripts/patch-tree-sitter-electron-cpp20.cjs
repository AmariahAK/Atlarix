/**
 * Electron 38+ ships V8 headers that require C++20; tree-sitter@0.21.x binding.gyp still uses C++17.
 * Patch vendored binding.gyp after npm install so @electron/rebuild / forge start can compile.
 */
const fs = require("fs");
const path = require("path");

const gypPath = path.join(__dirname, "..", "node_modules", "tree-sitter", "binding.gyp");
if (!fs.existsSync(gypPath)) {
  process.exit(0);
}

let s = fs.readFileSync(gypPath, "utf8");
if (s.includes('"CLANG_CXX_LANGUAGE_STANDARD": "c++20"')) {
  process.exit(0);
}

const before = s;
s = s.replace(/-std=c\+\+17/g, "-std=c++20");
s = s.replace(/"CLANG_CXX_LANGUAGE_STANDARD": "c\+\+17"/g, '"CLANG_CXX_LANGUAGE_STANDARD": "c++20"');
s = s.replace(/\/std:c\+\+17/g, "/std:c++20");
s = s.replace(/"MACOSX_DEPLOYMENT_TARGET": "10\.9"/g, '"MACOSX_DEPLOYMENT_TARGET": "11.0"');

if (s === before) {
  process.exit(0);
}

fs.writeFileSync(gypPath, s);
console.log("[patch-tree-sitter-electron-cpp20] updated binding.gyp (C++20)");
