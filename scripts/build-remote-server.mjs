#!/usr/bin/env node
/** Minimal tarball placeholder for remote server packaging (expand in CI). */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "packages/atlarix-remote-server/dist");
mkdirSync(out, { recursive: true });
writeFileSync(
  path.join(out, "index.js"),
  `console.log(JSON.stringify({ ok: true, stub: true, version: "8.9.0" }));\n`,
);
