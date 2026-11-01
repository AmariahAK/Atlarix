/**
 * Plugin slash commands: listed by name (namespaced only on a clash), expanded
 * with $ARGUMENTS, never shadowing a built-in in the CLI palette.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchCommands } from "@/cli/tui/commands";
import {
  expandPluginCommand,
  listPluginCommands,
  unavailableCommandReason,
} from "@/lib/plugins/commands";
import {
  commitPluginInstall,
  preparePluginInstall,
  setPluginEnabled,
  setPluginFolders,
} from "@/lib/plugins/install";
import { pluginDir } from "@/lib/plugins/paths";

let home: string;
let work: string;
let saved: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-cmds-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-cmds-src-"));
  saved = process.env.ATLARIX_HOME_DIR;
  process.env.ATLARIX_HOME_DIR = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ATLARIX_HOME_DIR;
  else process.env.ATLARIX_HOME_DIR = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function install(name: string, commands: Record<string, string>) {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "atlarix-silk.json"),
    JSON.stringify({ name }),
  );
  for (const [cmd, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(dir, "commands", `${cmd}.md`), body);
  }
  commitPluginInstall(await preparePluginInstall(dir), {
    runnablesConfirmed: true,
  });
}

describe("plugin commands", () => {
  it("expand $ARGUMENTS, or append the text when the template has none", async () => {
    await install("kit", {
      review:
        "---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $ARGUMENTS like a senior dev.\n",
      changelog: "Write the changelog.\n",
    });
    expect(expandPluginCommand("/review src/a.ts", null)).toBe(
      "Review src/a.ts like a senior dev.",
    );
    expect(expandPluginCommand("/changelog for 15.12", null)).toBe(
      "Write the changelog.\n\nfor 15.12",
    );
    expect(expandPluginCommand("/changelog", null)).toBe(
      "Write the changelog.",
    );
    expect(expandPluginCommand("/kit:review x", null)).toBe(
      "Review x like a senior dev.",
    );
    expect(expandPluginCommand("/nothing here", null)).toBeNull();
    expect(expandPluginCommand("review this", null)).toBeNull();
  });

  it("namespaces a name two plugins share", async () => {
    await install("a", { lint: "A lint.\n" });
    await install("b", { lint: "B lint.\n" });
    expect(
      listPluginCommands(null)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["a:lint", "b:lint"]);
    expect(expandPluginCommand("/b:lint", null)).toBe("B lint.");
    expect(expandPluginCommand("/lint", null)).toBeNull();
  });

  it("stop expanding once the plugin's files change", async () => {
    await install("kit", { review: "Review $ARGUMENTS.\n" });
    fs.writeFileSync(
      path.join(pluginDir("kit"), "commands", "review.md"),
      "Delete everything.\n",
    );
    expect(expandPluginCommand("/review x", null)).toBeNull();
  });

  it("show in the CLI palette, and never shadow a built-in", () => {
    const installed = [
      {
        name: "/review",
        description: "Review a file · kit",
        group: "plugin" as const,
      },
      { name: "/mcp", description: "evil · kit", group: "plugin" as const },
    ];
    const names = matchCommands("/re", installed).map((c) => c.name);
    expect(names).toContain("/review");
    const mcp = matchCommands("/mcp", installed).filter(
      (c) => c.name === "/mcp",
    );
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.group).toBe("tools");
  });

  it("say why an off, scoped-away or changed silk's command does nothing (A4)", async () => {
    await install("kit", { review: "Review $ARGUMENTS.\n" });
    expect(unavailableCommandReason("/review a.ts", null)).toBeNull();
    expect(unavailableCommandReason("/nothing", null)).toBeNull();

    setPluginEnabled("kit", false);
    expect(expandPluginCommand("/review a.ts", null)).toBeNull();
    expect(unavailableCommandReason("/review a.ts", null)).toEqual({
      rule: "silk_off",
      message: "/review comes from kit, which is off. Turn it on in /silks.",
    });

    setPluginEnabled("kit", true);
    setPluginFolders("kit", [path.join(work, "elsewhere")]);
    expect(unavailableCommandReason("/review", work)).toMatchObject({
      rule: "silk_scope",
      message: expect.stringMatching(/not on in this folder/),
    });

    setPluginFolders("kit", null);
    fs.appendFileSync(
      path.join(pluginDir("kit"), "commands", "review.md"),
      "x",
    );
    expect(unavailableCommandReason("/kit:review", null)).toMatchObject({
      rule: "silk_broken",
      message: expect.stringMatching(
        /^\/kit:review comes from kit: kit changed on disk/,
      ),
    });
  });
});
