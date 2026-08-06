/**
 * Which pipeline hosts Atlarix can actually poll.
 *
 * WHY A REGISTRY AND NOT AN ENUM
 * ------------------------------
 * The trigger used to be `kind: "github"` — a whole trigger kind, schema branch,
 * poller call and form tab, all named after one vendor. Adding GitLab meant
 * repeating every one of those, which is exactly how a product ends up hardcoded
 * to whichever service its author happened to use. The kind is `pipeline` now
 * and the vendor is a FIELD.
 *
 * `host` is a free-form string in the schema — nothing is enumerated there, in
 * the form, or in the tool description. What a host means is decided here, by
 * whether someone registered a poller for it.
 *
 * THE REGISTRY IS ALSO THE VALIDATION, DELIBERATELY.
 * A free-text host with no poller would save cleanly and then never fire —
 * indistinguishable from "nothing has happened yet", forever. That is the
 * shipped-half-feature shape deleted twice already in this release (the `ask`
 * ruleset key, `profile.taskCompleteGate`), and it is worse here because the
 * user is waiting on an alert that cannot arrive. So creating a pipeline for an
 * unregistered host is refused, naming what IS registered — a list that comes
 * from this map rather than from a sentence someone has to remember to update.
 *
 * Adding a host is therefore one entry plus a poller. Not a tab, not a schema
 * branch, not a prompt edit.
 */

import type { PipelineTrigger, GithubCursor } from "./types";

export type PipelinePollResult = {
  fired: boolean;
  context?: string | null;
  nextCursor: unknown;
};

export type PipelinePoller = (
  trigger: PipelineTrigger,
  cursor: unknown,
) => Promise<PipelinePollResult>;

export type PipelineHost = {
  /** Stable id, and what the user types. Lowercase. */
  id: string;
  /** Shown in the form. */
  label: string;
  /** What `repo` means for this host, e.g. "owner/name". */
  repoHint: string;
  poll: PipelinePoller;
};

const HOSTS = new Map<string, PipelineHost>();

export function registerPipelineHost(host: PipelineHost): void {
  HOSTS.set(host.id.toLowerCase(), host);
}

export function getPipelineHost(id: string): PipelineHost | undefined {
  return HOSTS.get(id.trim().toLowerCase());
}

export function listPipelineHosts(): PipelineHost[] {
  return [...HOSTS.values()];
}

/** The registered ids, for a message or a form list. Never hand-written. */
export function pipelineHostIds(): string[] {
  return listPipelineHosts().map((h) => h.id);
}

/**
 * Throws when nothing can poll this host.
 *
 * The message names the registered hosts because "unsupported" without a list
 * leaves the user (or the agent) guessing at spellings.
 */
export function assertPollableHost(host: string): PipelineHost {
  const found = getPipelineHost(host);
  if (!found) {
    const known = pipelineHostIds();
    throw new Error(
      `Atlarix can't poll "${host}" yet, so an automation for it would never fire. ` +
        (known.length
          ? `Supported right now: ${known.join(", ")}.`
          : "No pipeline hosts are registered in this build."),
    );
  }
  return found;
}

/** @internal tests — the registry is module state. */
export function resetPipelineHostsForTests(): void {
  HOSTS.clear();
}

/**
 * GitHub, the first entry — and the one the old hardcoded branch existed for.
 *
 * Registered here rather than inside the poller module so the registry stays the
 * single place that answers "what can we poll?", and so a poller cannot be
 * shipped without being reachable.
 */
registerPipelineHost({
  id: "github",
  label: "GitHub",
  repoHint: "owner/name",
  poll: async (trigger, cursor) => {
    const { pollGithub } = await import("./pollers/github");
    // The GitHub poller predates `pipeline` and still speaks the old shape; the
    // fields it reads are identical, so this is a cast rather than a rewrite.
    const result = await pollGithub(
      trigger as unknown as Parameters<typeof pollGithub>[0],
      (cursor ?? null) as GithubCursor | null,
    );
    return {
      fired: result.fired,
      context: result.context,
      nextCursor: result.nextCursor,
    };
  },
});
