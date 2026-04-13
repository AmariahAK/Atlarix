/**
 * Electron 38+ ships V8 headers that require C++20; tree-sitter@0.21.x binding.gyp
 * still uses C++17 in places. Patch every relevant binding.gyp under node_modules.
 *
 * Usage:
 *   node scripts/patch-tree-sitter-electron-cpp20.cjs              # repo root (default)
 *   node scripts/patch-tree-sitter-electron-cpp20.cjs <buildPath>   # e.g. forge packageAfterPrune dir
 */
const fs = require("fs");
const path = require("path");

const repoOrAppRoot = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const nodeModules = path.join(repoOrAppRoot, "node_modules");

/** Apply all known C++17 / legacy patterns → C++20 (idempotent on already-patched files). */
function patchBindingGypContent(s) {
  let t = s;
  // gnu++ before plain c++ so we do not partially match
  t = t.replace(/gnu\+\+17/g, "gnu++20");
  t = t.replace(/gnu\+\+14/g, "gnu++20");
  t = t.replace(/c\+\+17/g, "c++20");
  t = t.replace(/c\+\+14/g, "c++20");
  // MSVC
  t = t.replace(/\/std:c\+\+17/g, "/std:c++20");
  t = t.replace(/\/std:c\+\+14/g, "/std:c++20");
  // Xcode JSON strings (escaped backslashes in source are still one backslash in file)
  t = t.replace(/"CLANG_CXX_LANGUAGE_STANDARD": "c\+\+17"/g, '"CLANG_CXX_LANGUAGE_STANDARD": "c++20"');
  t = t.replace(/"CLANG_CXX_LANGUAGE_STANDARD": "gnu\+\+17"/g, '"CLANG_CXX_LANGUAGE_STANDARD": "gnu++20"');
  t = t.replace(/"CLANG_CXX_LANGUAGE_STANDARD": 'c\+\+17'/g, "'CLANG_CXX_LANGUAGE_STANDARD': 'c++20'");
  // Older macOS target often bundled with tree-sitter
  t = t.replace(/"MACOSX_DEPLOYMENT_TARGET": "10\.9"/g, '"MACOSX_DEPLOYMENT_TARGET": "11.0"');
  t = t.replace(/"MACOSX_DEPLOYMENT_TARGET": '10\.9'/g, "'MACOSX_DEPLOYMENT_TARGET': '11.0'");
  return t;
}

function collectBindingGypPaths() {
  const paths = [];
  if (!fs.existsSync(nodeModules)) {
    return paths;
  }
  const preferred = [
    "tree-sitter",
    "tree-sitter-typescript",
    "tree-sitter-javascript",
    "tree-sitter-python",
  ];
  const seen = new Set();
  for (const name of preferred) {
    const p = path.join(nodeModules, name, "binding.gyp");
    if (fs.existsSync(p)) {
      paths.push(p);
      seen.add(p);
    }
  }
  try {
    for (const ent of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith("tree-sitter")) continue;
      const p = path.join(nodeModules, ent.name, "binding.gyp");
      if (fs.existsSync(p) && !seen.has(p)) {
        paths.push(p);
        seen.add(p);
      }
    }
  } catch {
    /* ignore */
  }
  return paths;
}

function main() {
  const gypPaths = collectBindingGypPaths();
  if (gypPaths.length === 0) {
    process.exit(0);
  }

  let anyWritten = false;
  for (const gypPath of gypPaths) {
    let s = fs.readFileSync(gypPath, "utf8");
    const patched = patchBindingGypContent(s);
    if (patched !== s) {
      fs.writeFileSync(gypPath, patched, "utf8");
      anyWritten = true;
      console.log(
        `[patch-tree-sitter-electron-cpp20] updated ${path.relative(repoOrAppRoot, gypPath)} (C++20)`,
      );
    }
  }

  if (!anyWritten && process.env.CI) {
    console.log("[patch-tree-sitter-electron-cpp20] binding.gyp files already C++20 or no changes");
  }
}

main();
