/** @jsxImportSource @opentui/react */
// PROBE: stream a real reply through the CLI's markdown cell layout and print
// the final frame, to see wrapping/overlap bugs. Usage:
//   bun scripts/probes/stream-layout-probe.tsx <reply.md> [width] [chunk] [stream=1]
import { testRender } from "@opentui/react/test-utils";
import { readFileSync } from "node:fs";
import { useEffect, useState } from "react";
import { Prose } from "../../src/cli/tui/Prose";

const [file, w = "196", c = "24", s = "1", r = ""] = process.argv.slice(2);
const full = readFileSync(file!, "utf8");
const width = Number(w);
const chunk = Number(c);
const stream = s === "1";
const chunks = stream ? full.match(new RegExp(`[\\s\\S]{1,${chunk}}`, "g"))! : [full];

function Cell({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(stream ? 0 : chunks.length);
  const live = n < chunks.length;
  useEffect(() => {
    if (!live) return void setTimeout(onDone, 50);
    const t = setTimeout(() => setN(n + 1), 2);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row">
        <text flexShrink={0}>{"◆ "}</text>
        <box flexGrow={1}>
          <Prose text={chunks.slice(0, n).join("")} streaming={live} width={width - 3} />
        </box>
      </box>
    </box>
  );
}

let done = false;
const setup = await testRender(<Cell onDone={() => (done = true)} />, { width, height: 160 });
for (let i = 0; i < 20000 && !done; i++) {
  await new Promise((r) => setTimeout(r, 1));
  await setup.renderOnce();
}
await new Promise((r) => setTimeout(r, 800));
await setup.renderOnce();
if (r) {
  // The real transcript loses a column when its scrollbar appears: reflow.
  setup.resize(Number(r), 160);
  for (let i = 0; i < 5; i++) {
    await new Promise((res) => setTimeout(res, 100));
    await setup.renderOnce();
  }
}
console.log(setup.captureCharFrame());
setup.renderer.destroy();
process.exit(0);
