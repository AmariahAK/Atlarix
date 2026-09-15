/**
 * Skills the user wrote on their account, and how the model finds them.
 *
 * WHICH OF THE DESKTOP'S TWO PRESENTATIONS THIS COPIES, because it has two and
 * they are deliberately different. `formatSkillIndexForPrompt` renders a
 * WORKSPACE skill as a count and a directory — "7 skill file(s) in
 * `.atlarix/skills/`, grep that directory" — on the grounds that the model
 * already has grep and a `find_skill` tool "was written for this and deleted
 * the same day: it was a second way to do a thing that works". Bundled guides
 * get full index lines instead, because they live inside the app bundle where
 * grep cannot reach.
 *
 * THE EXTENSION HAS NO GREP AND NO FILESYSTEM, so it is in the bundled-guides
 * case, not the workspace one: full index lines in the prompt, bodies read on
 * demand through a tool. Reading the wrong half of that precedent would have
 * produced a directory path pointing at nothing.
 *
 * ONE READ TOOL, NOT TWO. `read_skill` is deliberately absent — `read_note`
 * already reads a named thing on demand, and a second tool with the same shape
 * is 90 tokens on every round to save the model a disambiguation it does not
 * find hard. Skills are addressed as `skill:<slug>`.
 */

import { GOTRUE } from "../auth/config";
import { getAccessToken } from "../auth/sign-in";
import { wrapUntrustedData } from "@/lib/streaming/untrusted-data";

export interface AccountSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
}

function restUrl(path: string): string {
  return `${GOTRUE.url.replace(/\/+$/, "")}/rest/v1/${path}`;
}

async function restHeaders(): Promise<Record<string, string> | null> {
  const token = await getAccessToken();
  if (!token) return null;
  return {
    apikey: GOTRUE.anonKey,
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Every enabled skill on the account. `[]` on any failure.
 *
 * READ STRAIGHT FROM POSTGREST, not through the proxy: a skill is the user's
 * own row under RLS, there is no credential involved, and routing it through
 * the proxy would make the panel's skill list depend on the proxy being up.
 * Same reasoning as the notes pull.
 */
export async function listAccountSkills(): Promise<AccountSkill[]> {
  try {
    const headers = await restHeaders();
    if (!headers) return [];
    const res = await fetch(
      restUrl(
        "account_skills?select=slug,name,description,body&enabled=is.true&order=name.asc",
      ),
      { headers },
    );
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    return Array.isArray(rows) ? (rows as AccountSkill[]) : [];
  } catch {
    return [];
  }
}

/**
 * The index lines the prompt carries.
 *
 * NAME AND DESCRIPTION ONLY — never the body, for the same arithmetic that
 * governs notes: a skill body may be 64 KB, and the whole point of an index is
 * that cost scales with the NUMBER of skills rather than their size.
 */
export function skillIndexLines(skills: AccountSkill[]): string {
  return skills
    .map((s) => {
      const hook = s.description.trim();
      return `- [${s.name}](skill:${s.slug})${hook ? ` — ${hook}` : ""}`;
    })
    .join("\n");
}

/** `skill:deploy`, `deploy`, or the whole index line — all accepted. */
export function parseSkillRef(raw: string): string {
  const s = raw.trim();
  const link = /\(skill:([^)]+)\)/.exec(s);
  if (link?.[1]) return link[1].trim();
  return s.replace(/^skill:/i, "").replace(/^[-*]\s*/, "").trim();
}

/**
 * A skill body, ready to hand to the model.
 *
 * WRAPPED AS UNTRUSTED DATA, and that is not paranoia about the user. A skill
 * is authored on a web page, and this agent reads web pages — so the path from
 * "a site talked the model into writing a skill" to "the model follows it next
 * week" exists, and the envelope is what keeps a procedure a procedure rather
 * than an instruction from the harness.
 */
export function renderSkill(skill: AccountSkill): string {
  return wrapUntrustedData(
    `skill:${skill.slug}`,
    `# ${skill.name}\n\n${skill.body}`,
  );
}
