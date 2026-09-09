import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Skills used to be pasted into every dispatch whole — and CLIPPED on the way in
 * (`cap(raw, 6_000)` cut a body mid-file, the 11th skill vanished, the names
 * summary stopped at 10). A truncated instruction is worse than an absent one,
 * because the model cannot tell it is reading a fragment.
 *
 * The property that replaced it, and the one that still matters most: NO BODY EVER
 * ENTERS THE PROMPT. `buildSkillIndex` reads the files, so a regression here would put
 * whole skill bodies back into every turn.
 *
 * v14.45 narrowed the second property. The prompt no longer carries a pointer PER
 * SKILL, because a workspace can hold any number of them and the model has grep; it
 * carries a count and the directory. Nothing is hidden — the count is of everything —
 * which is what distinguishes it from the old caps that silently dropped the 11th.
 */

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    }),
  },
}));

// No marketplace rows: this exercises the repo-skill path, which is the one with
// no size cap at all today.
vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

// The bundled-guide lookup resolves through Electron's app paths; point it at a
// directory that does not exist so guides drop out and the assertions below are
// purely about the workspace's own skills.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => path.join(os.tmpdir(), "atlarix-no-such-app-root"),
  },
}));

import { buildSkillIndex } from "@/lib/skills/skill-index";
import { formatSkillIndexForPrompt } from "@/lib/skills/skill-index";

const BODY_CANARY = "CANARY_SKILL_BODY_MUST_NOT_REACH_THE_PROMPT";

let workspace: string;

async function writeSkill(filename: string, frontmatter: string, body: string) {
  await fs.writeFile(
    path.join(workspace, ".atlarix", "skills", filename),
    `---\n${frontmatter}\n---\n\n${body}\n`,
    "utf8",
  );
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-skill-index-"));
  await fs.mkdir(path.join(workspace, ".atlarix", "skills"), {
    recursive: true,
  });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("skills index — pointers, not bodies", () => {
  it("keeps name/description/path on the ENTRY, and out of the prompt", async () => {
    await writeSkill(
      "house-style.md",
      "name: house-style\ndescription: Our TypeScript conventions.",
      `# House style\n\n${BODY_CANARY}\n\nAlways use tabs.`,
    );

    const entries = await buildSkillIndex(workspace, "build");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "house-style",
      description: "Our TypeScript conventions.",
      readPath: ".atlarix/skills/house-style.md",
      source: "repo",
    });

    // The ENTRY carries name/description/path — `read_file` needs them, and the
    // settings page renders them. The PROMPT carries neither, only a count.
    const prompt = formatSkillIndexForPrompt(entries);
    expect(prompt).toContain("1");
    expect(prompt).toContain(".atlarix/skills/");
    expect(prompt).not.toContain("house-style");
    expect(prompt).not.toContain(BODY_CANARY);
  });

  it("a huge skill costs nothing in the prompt — no cap needed", async () => {
    // 200 KB: well past every limit the old loader enforced (6 KB per skill,
    // 24 KB total), which would have silently truncated this mid-sentence.
    await writeSkill(
      "giant.md",
      "name: giant\ndescription: A very large skill.",
      `${BODY_CANARY}\n${"filler line for the body. ".repeat(8000)}`,
    );

    const prompt = formatSkillIndexForPrompt(
      await buildSkillIndex(workspace, "build"),
    );
    expect(prompt).not.toContain(BODY_CANARY);
    expect(prompt).not.toContain("giant");
    expect(prompt.length).toBeLessThan(800);
  });

  it("counts all 15 skills — the 11th is not written out of existence", async () => {
    for (let i = 0; i < 15; i++) {
      await writeSkill(
        `skill-${String(i).padStart(2, "0")}.md`,
        `name: skill-${i}\ndescription: Number ${i}.`,
        `${BODY_CANARY}\nbody ${i}`,
      );
    }

    const entries = await buildSkillIndex(workspace, "build");
    expect(entries).toHaveLength(15);

    // Every skill is COUNTED — which is the invariant this test has always been for.
    // It used to check that the 11th got a line; now it checks the 15th is in the
    // number, because being counted is what stops the model believing it does not
    // exist. No body, and no per-skill line either.
    const prompt = formatSkillIndexForPrompt(entries);
    expect(prompt).toContain("15");
    for (let i = 0; i < 15; i++) {
      expect(prompt).not.toContain(`skill-${i}`);
    }
    expect(prompt).not.toContain(BODY_CANARY);
  });

  // Each of these is valid YAML for the same list, and all three appear in the
  // wild. The parser used to accept only the JSON-quoted form — the other two
  // threw, fell through to scalar, and left `modes` unset, which the loader
  // reads as "applies in EVERY mode". A Debug-only skill silently became a
  // load-everywhere skill: the exact inverse of what its author wrote.
  it.each([
    ["JSON-quoted", 'compatibleModes: ["Debug"]'],
    ["single-quoted", "compatibleModes: ['Debug']"],
    ["bare scalars", "compatibleModes: [Debug]"],
    ["block list", "compatibleModes:\n  - Debug"],
  ])(
    "honours a mode restriction written as %s",
    async (_label, frontmatterLine) => {
      await writeSkill(
        "debug-only.md",
        `name: debug-only\ndescription: Only for debugging.\n${frontmatterLine}`,
        "body",
      );

      expect(await buildSkillIndex(workspace, "debug")).toHaveLength(1);
      expect(await buildSkillIndex(workspace, "ask")).toHaveLength(0);
    },
  );

  it("keeps multi-item flow sequences intact", async () => {
    await writeSkill(
      "build-review.md",
      "name: build-review\ndescription: Two modes.\ncompatibleModes: [Build, Review]",
      "body",
    );

    expect(await buildSkillIndex(workspace, "build")).toHaveLength(1);
    expect(await buildSkillIndex(workspace, "review")).toHaveLength(1);
    expect(await buildSkillIndex(workspace, "plan")).toHaveLength(0);
  });

  it("falls back to the body's first sentence when a skill omits a description", async () => {
    await writeSkill(
      "nodesc.md",
      "name: nodesc",
      "Formats invoices for the billing service. More detail follows here.",
    );

    const [entry] = await buildSkillIndex(workspace, "build");
    expect(entry.description).toBe("Formats invoices for the billing service.");
  });

  it("renders nothing when the workspace has no skills", async () => {
    expect(
      formatSkillIndexForPrompt(await buildSkillIndex(workspace, "build")),
    ).toBe("");
  });

  // OWNER DIRECTIVE: a granted folder gives the agent FILES, never AUTHORITY.
  // Skills are instructions the agent is nudged to read, so a second repo must
  // never be able to inject one just because the user allowed writes there.
  // This holds structurally — the index is built from `appPath` alone — and this
  // test is what keeps it that way if someone later threads granted roots in.
  it("never indexes skills from a folder outside the workspace", async () => {
    await writeSkill(
      "mine.md",
      "name: mine\ndescription: Belongs to this project.",
      "body",
    );

    const other = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-other-ws-"));
    try {
      await fs.mkdir(path.join(other, ".atlarix", "skills"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(other, ".atlarix", "skills", "theirs.md"),
        `---\nname: theirs\ndescription: From another repo.\n---\n\n${BODY_CANARY}\n`,
        "utf8",
      );

      const entries = await buildSkillIndex(workspace, "build");
      expect(entries.map((e) => e.name)).toEqual(["mine"]);
      const prompt = formatSkillIndexForPrompt(entries);
      expect(prompt).not.toContain("theirs");
      expect(prompt).not.toContain(BODY_CANARY);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
