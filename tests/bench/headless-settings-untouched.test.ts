import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupEvalContext, getIpcHandler, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { getUserDataDirOverride } from "../infra/user-data-override";
import { runHeadlessAgent } from "@/headless/headless-runner";
import { setPinnedProviderKey } from "@/ipc/shared/pinned-provider-key";

/**
 * `atlarix run` REPLACED the profile's whole user-settings.json (QA A5,
 * 2026-10-22): unknown keys gone, telemetryConsent flipped to opted_out, the
 * run's model left selected, and with `--api-key` the key stored there in
 * plaintext. On a real profile (a script, CI, the team's shared test account)
 * that is data loss. A run's choices now live in memory for the run only.
 */
let ctx: EvalContext;
let wsDir: string;
let settingsFile: string;

const BEFORE = {
  hasRunBefore: true,
  telemetryConsent: "opted_in",
  selectedModel: { name: "auto", provider: "atlarix" },
  selectedChatMode: "build",
  providerSettings: { openai: { apiKey: { value: "sk-existing" } } },
  qaCanary: "keep-me",
  customUserSetting: 42,
};
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

beforeAll(async () => {
  ctx = await setupEvalContext();
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-hl-settings-ws-"));
  settingsFile = path.join(getUserDataDirOverride()!, "user-settings.json");
});

afterEach(() => setPinnedProviderKey("atlarix-headless", null));

afterAll(async () => {
  await ctx.cleanup();
  fs.rmSync(wsDir, { recursive: true, force: true });
  delete process.env.ATLARIX_HEADLESS;
  delete process.env.ATLARIX_DISABLE_TEXT_TOOLS;
  delete process.env.ATLARIX_USER_DATA_DIR;
});

describe("a headless run leaves the profile's settings alone", () => {
  for (const [label, sc, apiKey] of [
    ["--api-key", "hl-settings-api-key", "sk-run-key"],
    ["a key file (pinned)", "hl-settings-key-file", undefined],
    ["no key", "hl-settings-no-key", undefined],
  ] as const) {
    it(`with ${label}`, async () => {
      fs.writeFileSync(settingsFile, JSON.stringify(BEFORE, null, 2));
      const before = sha(settingsFile);
      if (label.startsWith("a key file")) setPinnedProviderKey("atlarix-headless", "sk-file-key");

      ctx.server.register(scenario(sc).text("ready").build());
      const res = await runHeadlessAgent({
        workspaceDir: wsDir,
        prompt: `sc=${sc} say ready`,
        provider: { baseUrl: ctx.server.baseURL, model: "hl-model", ...(apiKey ? { apiKey } : {}) },
        mode: "ask",
        timeoutMs: 30_000,
        resolveHandler: (channel) => getIpcHandler(channel),
      });

      expect(res.completed).toBe(true);
      // The run used its own model and mode...
      expect(ctx.server.requestsFor(sc).length).toBeGreaterThan(0);
      // ...and the file on disk is exactly what it was.
      expect(sha(settingsFile)).toBe(before);
      expect(fs.readFileSync(settingsFile, "utf8")).not.toContain("sk-run-key");
    });
  }
});
