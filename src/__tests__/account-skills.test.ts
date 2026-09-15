/**
 * Skills written on atlarix.dev, made readable by the desktop.
 *
 * THREE PROPERTIES, and each has a failure that is silent rather than loud:
 *
 *  - **The body never enters the prompt.** `account_skills.body` is allowed
 *    64 KB by its CHECK constraint and the skill index is sent on EVERY turn.
 *    A regression here is a quiet, permanent cost on every message.
 *  - **A deleted skill stops being readable.** The worst kind of stale: the
 *    model reads an instruction the user removed weeks ago and follows it, and
 *    the user has no idea where it came from.
 *  - **A slug cannot escape the directory.** The database constrains the shape,
 *    but that constraint is on the server and this writes to the user's disk.
 *    Trusting a remote value at the point it touches a filesystem is the wrong
 *    place to be trusting, however well constrained it was where it came from.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

let userData: string;

vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

let rows: Array<Record<string, unknown>> = [];
let signedIn = true;
let readError: { code: string; message: string } | null = null;

vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: async () => (signedIn ? { access_token: "t" } : null),
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () =>
            readError ? { data: null, error: readError } : { data: rows, error: null },
        }),
      }),
    }),
  }),
}));

import {
  clearAccountSkillsCache,
  listAccountSkills,
  materialiseAccountSkills,
} from "@/lib/skills/account-skills";

const BODY_CANARY = "CANARY_ACCOUNT_SKILL_BODY_MUST_NOT_REACH_THE_PROMPT";

function skill(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    name: slug,
    description: `What ${slug} is for.`,
    body: `${BODY_CANARY}\n\nStep one.`,
    ...extra,
  };
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-account-skills-"));
  rows = [];
  signedIn = true;
  readError = null;
  clearAccountSkillsCache();
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

describe("what reaches the index", () => {
  it("returns a name, a description and a PATH — never the body", async () => {
    rows = [skill("deploy")];

    const entries = await materialiseAccountSkills();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "deploy",
      description: "What deploy is for.",
    });
    // The whole point: the canary is on disk, reachable by read_file, and
    // nowhere in what the prompt will be built from.
    expect(JSON.stringify(entries)).not.toContain(BODY_CANARY);
    expect(await fs.readFile(entries[0]!.readPath, "utf8")).toContain(BODY_CANARY);
  });
});

describe("a skill the user deleted stops being readable", () => {
  it("removes the file when the skill is gone from the account", async () => {
    rows = [skill("deploy"), skill("triage")];
    const first = await materialiseAccountSkills();
    expect(first).toHaveLength(2);

    rows = [skill("deploy")];
    clearAccountSkillsCache();
    const second = await materialiseAccountSkills();

    expect(second.map((e) => e.name)).toEqual(["deploy"]);
    const left = await fs.readdir(path.join(userData, "account-skills"));
    expect(left).toEqual(["deploy.md"]);
  });
});

describe("a slug that is not a slug", () => {
  it("refuses to write outside its own directory", async () => {
    rows = [skill("../../escaped"), skill("ok")];

    const entries = await materialiseAccountSkills();

    expect(entries.map((e) => e.name)).toEqual(["ok"]);
    const left = await fs.readdir(path.join(userData, "account-skills"));
    expect(left).toEqual(["ok.md"]);
  });
});

describe("the quiet paths are quiet", () => {
  it("is an empty list when signed out — BYOK is a supported way to run", async () => {
    signedIn = false;
    rows = [skill("deploy")];
    await expect(listAccountSkills()).resolves.toEqual([]);
  });

  it("is an empty list when the table has not shipped to this account", async () => {
    readError = { code: "42P01", message: "relation does not exist" };
    await expect(listAccountSkills()).resolves.toEqual([]);
  });

  it("caches, so a twenty-message conversation is not twenty round trips", async () => {
    rows = [skill("deploy")];
    await listAccountSkills();
    rows = [skill("deploy"), skill("triage")];
    // No cache clear: the second read must not see the change.
    await expect(listAccountSkills()).resolves.toHaveLength(1);
  });
});
