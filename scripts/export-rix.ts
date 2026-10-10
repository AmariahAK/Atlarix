/**
 * Writes Rix's static files from `src/lib/rix/rix-svg.ts`, the one source.
 *
 *   bun scripts/export-rix.ts            → assets/rix/
 *   bun scripts/export-rix.ts <out-dir>  → somewhere else (the site's public/)
 *
 * One file per state, because an `<img>` cannot switch a class: each file
 * carries its own animation and runs anywhere an SVG does (site, README,
 * video pipeline).
 */
import fs from "node:fs";
import path from "node:path";
import { RIX_GLYPH_SVG, RIX_STATES, rixSvg } from "../src/lib/rix/rix-svg";

const out = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "assets", "rix"));
fs.mkdirSync(out, { recursive: true });

const write = (name: string, svg: string) => {
  fs.writeFileSync(path.join(out, name), `${svg}\n`);
  console.log(`${path.relative(process.cwd(), path.join(out, name))}`);
};

for (const state of RIX_STATES) {
  write(state === "rest" ? "rix.svg" : `rix-${state}.svg`, rixSvg({ state, id: "rix", size: "200px" }));
}
write("rix-mid.svg", rixSvg({ state: "rest", id: "rix", size: "64px", detail: "mid" }));
write("rix-glyph.svg", RIX_GLYPH_SVG);
