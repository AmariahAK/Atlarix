/** @jsxImportSource @opentui/react */
// PROBE: render <markdown> in a compiled binary with the test renderer, the
// way the CLI does: content arriving in chunks (streaming), then complete.
import { testRender } from "@opentui/react/test-utils";
import { useEffect, useState } from "react";
import { syntax } from "../../src/cli/tui/theme";

const full = "Here is code:\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nDone.";
const chunks = full.match(/.{1,4}/gs)!;

function Streaming({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= chunks.length) return onDone();
    const t = setTimeout(() => setN(n + 1), 15);
    return () => clearTimeout(t);
  }, [n]);
  return <markdown content={chunks.slice(0, n).join("")} syntaxStyle={syntax} conceal />;
}

let done = false;
const setup = await testRender(<Streaming onDone={() => (done = true)} />, { width: 60, height: 12 });
for (let i = 0; i < 200 && !done; i++) {
  await new Promise((r) => setTimeout(r, 20));
  await setup.renderOnce();
}
await new Promise((r) => setTimeout(r, 600));
await setup.renderOnce();
console.log(setup.captureCharFrame());
setup.renderer.destroy();
process.exit(0);
