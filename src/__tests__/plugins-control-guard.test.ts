/**
 * The agent never changes plugin files, plugins.json or hooks.json on its own:
 * file writes are refused, commands always ask, the sandbox never grants them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enrichPermissionRequestForUi,
  shouldSkipPermissionWait,
} from "@/ipc/handlers/chat_stream/permission-ui";
import {
  grantCoversPluginControl,
  guardPluginControl,
  touchesPluginControl,
} from "@/lib/plugins/control-guard";
import { pluginControlDenyPaths } from "@/lib/sandbox/deny-paths";
import { _normalizeForCompare } from "@/lib/plugins/paths";

let home: string;
let saved: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-guard-home-"));
  saved = process.env.ATLARIX_HOME_DIR;
  process.env.ATLARIX_HOME_DIR = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ATLARIX_HOME_DIR;
  else process.env.ATLARIX_HOME_DIR = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

const edit = (p: string) => ({ operation: "edit_file", preview: { path: p } });
const cmd = (command: string) => ({
  operation: "run_command",
  preview: { command },
});

describe("file writes", () => {
  it("refuses an edit to the person's hooks.json, by absolute path", () => {
    const g = guardPluginControl(
      edit(path.join(home, "edicts.json")),
      "/some/project",
    );
    expect(g.pluginControl).toBe(true);
    expect(g.refusal).toMatch(/changed by the person/);
  });

  it("refuses an edit inside an installed plugin when the workspace IS the home folder", () => {
    // A relative path in a workspace that contains the plugins folder.
    const g = guardPluginControl(edit("silks/acme/hooks/hooks.json"), home);
    expect(g.refusal).not.toBeNull();
  });

  it("refuses a rename into the plugins folder", () => {
    const req = {
      operation: "rename_file",
      preview: {
        fromPath: "/tmp/x.json",
        toPath: path.join(home, "silks.json"),
      },
    };
    expect(guardPluginControl(req, "/tmp").refusal).not.toBeNull();
  });

  it("refuses an edit to the person's ~/.agents skills", () => {
    const skill = path.join(
      path.dirname(home),
      ".agents",
      "skills",
      "x",
      "SKILL.md",
    );
    expect(guardPluginControl(edit(skill), "/p").refusal).not.toBeNull();
  });

  it("leaves ordinary writes alone", () => {
    const g = guardPluginControl(edit("src/index.ts"), "/some/project");
    expect(g).toEqual({
      permRequest: edit("src/index.ts"),
      pluginControl: false,
      refusal: null,
    });
    // A workspace's own .atlarix/hooks.json is not the person's hooks file.
    expect(
      touchesPluginControl(edit(".atlarix/hooks.json"), "/some/project"),
    ).toBe(false);
  });
});

describe("links", () => {
  it("refuses an edit through a link in the workspace that points at the control files", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-guard-ws-"));
    try {
      fs.symlinkSync(home, path.join(ws, "cfg"));
      expect(
        guardPluginControl(edit("cfg/edicts.json"), ws).refusal,
      ).not.toBeNull();
      expect(
        guardPluginControl(edit("cfg/silks/acme/x.sh"), ws).refusal,
      ).not.toBeNull();
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it("denies the real location too when the home folder is itself a link", () => {
    const realHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlarix-guard-real-"),
    );
    const linkParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "atlarix-guard-link-"),
    );
    try {
      const linked = path.join(linkParent, ".atlarix");
      fs.symlinkSync(realHome, linked);
      process.env.ATLARIX_HOME_DIR = linked;
      const real = fs.realpathSync(realHome);
      expect(pluginControlDenyPaths()).toEqual(
        expect.arrayContaining([linked, real]),
      );
      expect(
        guardPluginControl(edit(path.join(real, "edicts.json")), "/p").refusal,
      ).not.toBeNull();
    } finally {
      fs.rmSync(realHome, { recursive: true, force: true });
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  });
});

describe("commands", () => {
  it("always ask, unattended approvers refuse, and no 'always allow' is offered", () => {
    for (const c of [
      `echo '{}' > ${path.join(home, "edicts.json")}`,
      "cp evil.json ~/.atlarix/edicts.json",
      "rm -rf $HOME/.atlarix/silks/acme",
      "cd ~/.atlarix && echo '{}' > edicts.json",
      "cp x.json ~/.atl*/edicts.json",
      "mv ~/.atlarix /tmp/x",
    ]) {
      const g = guardPluginControl(cmd(c), "/p");
      expect(g.pluginControl, c).toBe(true);
      expect(g.refusal).toBeNull();
      expect(g.permRequest.preview).toMatchObject({
        systemScope: true,
        canAlwaysAllow: false,
      });
    }
  });

  it("always ask for Windows forms, renaming the home folder included", () => {
    for (const c of [
      String.raw`copy evil.json C:\Users\p\.atlarix\edicts.json`,
      String.raw`Set-Content -Path $env:USERPROFILE\.atlarix\silks.json -Value x`,
      String.raw`del %USERPROFILE%\.atlarix\silks\acme\mod\index.js`,
      String.raw`Move-Item $HOME\.atlarix C:\tmp\x`,
      String.raw`ren %USERPROFILE%\.atlarix atl2`,
      String.raw`Copy-Item x.json -Destination "$env:USERPROFILE\.ATLARIX\Edicts.json"`,
    ]) {
      expect(guardPluginControl(cmd(c), "C:\\w").pluginControl, c).toBe(true);
    }
    expect(
      guardPluginControl(
        cmd(String.raw`type %USERPROFILE%\.atlarix\projects\x\memory.md`),
        "C:\\w",
      ).pluginControl,
    ).toBe(false);
  });

  it("leave reads of the home folder alone", () => {
    expect(
      guardPluginControl(cmd("ls ~/.atlarix/projects"), "/p").pluginControl,
    ).toBe(false);
  });

  it("outranks auto-approve and 'Allow all this turn'", () => {
    expect(
      shouldSkipPermissionWait(cmd("x"), {
        pluginControl: true,
        reviewOverridden: true,
        autoApproved: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipPermissionWait(cmd("x"), {
        reviewOverridden: true,
        autoApproved: true,
      }),
    ).toBe(true);
  });

  it("does not trip on a folder whose name only starts with .atlarix", () => {
    // `.atlarix-e2e`, `.atlarix-notes`, `.atlarix.bak` are siblings, not the
    // home folder: writing into them must not ask for the silks/edicts card.
    for (const c of [
      "echo x >> ~/.atlarix-e2e/f",
      "> ~/.atlarix-notes/a",
      "cp a ~/.atlarix.bak/",
    ]) {
      expect(touchesPluginControl(cmd(c), "/p"), c).toBe(false);
    }
  });

  it("does not trip on a sibling folder beside the configured home dir", () => {
    // The expanded home dir is matched too, and it must stop at the segment
    // boundary: `<home>-e2e` is not `<home>`.
    for (const c of [
      `cp a ${home}-e2e/f`,
      `mv x ${home}-notes/a`,
      `rm -rf ${home}.bak`,
    ]) {
      expect(touchesPluginControl(cmd(c), "/p"), c).toBe(false);
    }
  });

  it("still asks for the home folder itself, globs to it, and brace forms", () => {
    for (const c of [
      "> ~/.atlarix/edicts.json",
      "cd ~/.atlarix && > x",
      "rm ~/.atl*/edicts.json",
      "> ~/.atlarix*",
      // Brace expansion and a trailing `:` name the folder, not a sibling.
      "tee ~/{.atlarix,/tmp}/x",
      "cp a ~/{x,.atlarix}/y",
      "cp a ~/.atlarix:",
    ]) {
      expect(touchesPluginControl(cmd(c), "/p"), c).toBe(true);
    }
  });

  it("keeps its marking after the card's enrichment recomputes systemScope", () => {
    const enriched = enrichPermissionRequestForUi(
      cmd("cat x > ~/.atlarix/edicts.json"),
      null,
      "/p",
      false,
    );
    expect(enriched.preview).toMatchObject({
      systemScope: true,
      canAlwaysAllow: false,
    });
  });
});

describe("sandbox", () => {
  it("denies the whole home folder on every run", () => {
    expect(pluginControlDenyPaths()).toEqual(expect.arrayContaining([home]));
  });

  it("never offers a grant that would cover them", () => {
    expect(grantCoversPluginControl(path.join(home, "silks", "acme"))).toBe(
      true,
    );
    expect(grantCoversPluginControl(home)).toBe(true);
    expect(grantCoversPluginControl(path.dirname(home))).toBe(true);
    // Anywhere in the home folder: the sandbox denies all of it.
    expect(grantCoversPluginControl(path.join(home, "node_modules"))).toBe(
      true,
    );
    expect(
      grantCoversPluginControl(path.join(os.tmpdir(), "elsewhere-x")),
    ).toBe(false);
    expect(grantCoversPluginControl("/opt/homebrew")).toBe(false);
  });
});

describe("Windows spellings", () => {
  it("compare hooks.json., hooks.json and hooks.json::$DATA as the same file", () => {
    const n = (p: string) => _normalizeForCompare(p, "win32");
    const want = n("C:\\Users\\p\\.atlarix\\hooks.json");
    expect(n("C:\\Users\\p\\.atlarix\\hooks.json.")).toBe(want);
    expect(n("C:\\Users\\p\\.atlarix\\hooks.json ")).toBe(want);
    expect(n("C:\\Users\\p\\.atlarix\\hooks.json::$DATA")).toBe(want);
    expect(n("c:\\users\\P\\.ATLARIX.\\HOOKS.json")).toBe(want);
  });
});
