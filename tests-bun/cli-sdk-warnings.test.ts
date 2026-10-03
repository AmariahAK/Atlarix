/**
 * An attached image goes to the model as a `file` part. AI SDK 7 deprecated the
 * `image` part, and every turn with a screenshot printed its DeprecationWarning
 * over the terminal app's prompt box. Fails with the old part (checked).
 */
import { expect, it } from "bun:test";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
it("a turn with an attached image raises no AI SDK warning", async () => {
  const warnings: string[] = [];
  process.on("warning", (w) => warnings.push(`${w.name}: ${w.message}`));
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "warn-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1"; process.env.ATLARIX_SURFACE = "cli";
  process.on("unhandledRejection", () => {});
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "warn-ws-"));
  const png = path.join(ws, "shot.png");
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const { startFakeLlm } = await import("./fixtures/fake-llm");
  const llm = startFakeLlm([{ text: "A red dot." }]);
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const model = await seedDevProvider({ baseUrl: llm.url, model: "gpt-4o", apiKey: "dev" });
  const s = new AgentSession({ workspaceDir: ws, model }); await s.start();
  await new Promise<void>((res) => { let started = false; s.on("change", (st: any) => { if (st.busy) started = true; if (started && !st.busy) res(); }); void s.submit("[Image #1] what is this?", { images: [{ path: png, mime: "image/png", label: "[Image #1]" }] }); });
  await new Promise((r) => setTimeout(r, 1000));
  const sent = JSON.stringify(llm.requests.at(-1)?.messages ?? []);
  expect(sent.includes("data:image/png")).toBe(true); // the image still reaches the model
  expect(warnings.filter((w) => w.includes("AI SDK"))).toEqual([]);
}, 120000);
