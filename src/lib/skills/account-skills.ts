/**
 * Skills the user wrote on atlarix.dev, read into the desktop's skill index.
 *
 * THE ACCOUNT PAGE HAS PROMISED THIS FOR A WHILE. Its Skills row sits beside
 * Connectors, whose blurb reads "Added once here and available in the app, the
 * browser extension and the CLI" — and the app was not a participant in either.
 * `account_skills` had exactly one reader, the browser extension. This is the
 * second.
 *
 * READ DIRECTLY, NOT THROUGH THE PROXY, which is the same call the extension
 * makes and for the same reason: a skill is the user's own row under RLS with no
 * credential involved, so routing it through the Core proxy would make the skill
 * list depend on the proxy being up. Connectors are the opposite case — their
 * credentials are held by the proxy and must have exactly one holder — which is
 * why the two surfaces are fetched differently and should stay that way.
 *
 * SIGNED OUT IS NOT AN ERROR. Atlarix runs perfectly well without an account
 * (BYOK), and a user who has never signed in has no account skills — the same
 * outcome as a user who has none. Both are an empty list, never a thrown error
 * and never a warning in their face.
 *
 * THE BODY IS NEVER INDEXED. `account_skills.body` is allowed 64 KB by its CHECK
 * constraint, and the index is sent on every turn. Names and descriptions go in
 * the index; the body is fetched only when the model asks to read one.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { app } from "electron";
import log from "electron-log";

import { getSession, getSupabaseClient } from "@/lib/auth/supabase-client";

const logger = log.scope("account-skills");

export interface AccountSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
}

/**
 * How long a fetched list is reused before asking again.
 *
 * The index is built on EVERY turn, and a user's skill list changes about as
 * often as they visit the account page. Without this, a conversation of twenty
 * messages is twenty round trips for an answer that did not move — and every
 * traffic scare this project has had has turned out to be one of our own
 * avoidable requests.
 */
const CACHE_MS = 60_000;

let cache: { at: number; skills: AccountSkill[] } | null = null;

/** Drop the cache — called when the signed-in user changes. */
export function clearAccountSkillsCache(): void {
  cache = null;
}

/**
 * The user's enabled account skills, or an empty list.
 *
 * Never throws. A failure here must cost an omitted prompt section and nothing
 * else: the alternative is a turn that refuses to start because a website the
 * user is not currently thinking about was unreachable.
 */
export async function listAccountSkills(): Promise<AccountSkill[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.skills;

  try {
    const session = await getSession();
    if (!session) {
      cache = { at: now, skills: [] };
      return [];
    }

    // Columns are named rather than `*`: PostgREST returns exactly what is
    // asked for, and a `*` here would pull every column added to this table
    // later — including any that is large or that we have no business reading.
    const { data, error } = await getSupabaseClient()
      .from("account_skills")
      .select("slug, name, description, body")
      .eq("enabled", true)
      .order("name", { ascending: true });

    if (error) {
      // A missing relation means the table has not shipped to this account yet,
      // which is a normal state and not worth a log line every minute.
      if (error.code !== "42P01" && error.code !== "PGRST205") {
        logger.warn("[account-skills] read failed:", error.message);
      }
      cache = { at: now, skills: [] };
      return [];
    }

    const skills = (data ?? []).flatMap((row): AccountSkill[] => {
      const slug = typeof row.slug === "string" ? row.slug : "";
      const name = typeof row.name === "string" ? row.name : "";
      if (!slug || !name) return [];
      return [
        {
          slug,
          name,
          description: typeof row.description === "string" ? row.description : "",
          body: typeof row.body === "string" ? row.body : "",
        },
      ];
    });

    cache = { at: now, skills };
    return skills;
  } catch (err) {
    logger.warn("[account-skills] read threw:", err);
    cache = { at: now, skills: [] };
    return [];
  }
}

/**
 * Where a fetched account skill is put so `read_file` can reach it.
 *
 * WHY DISK AND NOT A NEW TOOL. A repo skill is found with `grep` and read with
 * `read_file`; a bundled guide is listed with an absolute path and read with
 * `read_file`. An account skill has neither — a database row is not a path — so
 * the choice is a new `read_account_skill` tool or giving the row a path. The
 * path wins: it is the third case of a pattern that already works twice, it adds
 * no tool for the model to learn or mis-call, and the body (up to 64 KB) stays
 * out of the prompt until it is actually wanted.
 *
 * Under `userData`, never in the user's repo. These are not project files and
 * must never appear in a diff, a commit, or a `grep` over the workspace.
 */
function accountSkillsDir(): string {
  return path.join(app.getPath("userData"), "account-skills");
}

/** A slug that could escape the directory is not a slug. */
function safeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(slug);
}

/**
 * Write the user's account skills to disk and describe them for the index.
 *
 * REWRITTEN EVERY TIME, and stale files are removed. A skill the user deleted on
 * the website that went on being readable here would be the worst kind of stale:
 * the model would read it, follow it, and the user would have no idea where the
 * instruction came from.
 *
 * The slug check is a path-traversal guard even though the database has a CHECK
 * constraint enforcing the same shape. The constraint is on the server and this
 * writes to the user's disk — it is the wrong place to trust a remote value,
 * however well constrained it is where it came from.
 */
export async function materialiseAccountSkills(): Promise<
  Array<{ name: string; description: string; readPath: string }>
> {
  const skills = await listAccountSkills();

  let dir: string;
  try {
    // Inside the try: `app.getPath` throws before Electron is ready, and this
    // runs from prompt assembly rather than from a lifecycle hook.
    dir = accountSkillsDir();
    await fs.mkdir(dir, { recursive: true });
    const wanted = new Set<string>();

    for (const skill of skills) {
      if (!safeSlug(skill.slug)) {
        logger.warn(`[account-skills] refusing unsafe slug: ${skill.slug}`);
        continue;
      }
      const file = `${skill.slug}.md`;
      wanted.add(file);
      const body = `# ${skill.name}\n\n${skill.body}\n`;
      // Only when it differs: an unchanged rewrite every minute would churn the
      // user's disk and their backup tool for nothing.
      let existing: string | null = null;
      try {
        existing = await fs.readFile(path.join(dir, file), "utf8");
      } catch {
        /* not there yet */
      }
      if (existing !== body) await fs.writeFile(path.join(dir, file), body, "utf8");
    }

    for (const entry of await fs.readdir(dir)) {
      if (entry.endsWith(".md") && !wanted.has(entry)) {
        await fs.rm(path.join(dir, entry), { force: true });
      }
    }
  } catch (err) {
    logger.warn("[account-skills] could not write to disk:", err);
    return [];
  }

  return skills
    .filter((s) => safeSlug(s.slug))
    .map((s) => ({
      name: s.name,
      description: s.description,
      readPath: path.join(dir, `${s.slug}.md`),
    }));
}
