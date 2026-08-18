/**
 * `proposals` — review what a writer sub-agent wants to change (v14.21.0).
 *
 * `task` spawns; `proposals` reviews. A writer sub-agent's edits are captured
 * rather than written (see lib/agents/subagent-proposals.ts), and this is the
 * tool the MAIN agent uses to look at them and decide.
 *
 * The load-bearing design choice is in `accept`: it returns a
 * `__permission_required` envelope with `operation: "edit_file"`. The approval
 * interceptor routes by that field, not by which tool produced the envelope, so
 * an accepted proposal travels the exact path a main-agent edit travels —
 * file-scope always-allow, the user's approval card, the real write. That means
 *
 *   - the main agent NEVER re-types the change (it accepts by reference, and
 *     the harness writes the sub-agent's exact bytes), and
 *   - the human gate is unchanged: a file that isn't already always-allowed
 *     still asks the user, same as any other edit.
 *
 * One file per accept call, deliberately: it matches the one-envelope-per-call
 * shape the interceptor expects, and gives per-file granularity. The model can
 * batch several accepts in one response.
 */

import {
  ToolRegistry,
  createParameters,
  stringParam,
} from "./registry";
import {
  deleteProposalSet,
  listProposalSetsForChat,
  readCurrentDiskContent,
  type ProposalSet,
  type ProposedFile,
} from "../agents/subagent-proposals";
import {
  buildProposalFileViews,
  findProposalConflicts,
  formatUnifiedDiff,
  rebaseOntoCurrent,
} from "../agents/subagent-proposal-review";

/**
 * Resolve `proposal` the same way `background_jobs` resolves `job`: exact id,
 * then the agent name, then a substring — with an ambiguity error that LISTS
 * the candidates rather than failing blind. One addressing dialect, not two.
 */
/** Test seam — the addressing rules are the thing worth pinning, not the tool shell. */
export function resolveSet(
  chatId: number,
  wanted: string,
): { set: ProposalSet } | { error: string } {
  const sets = listProposalSetsForChat(chatId);
  if (sets.length === 0) {
    return { error: "No sub-agent proposals are awaiting review in this session." };
  }
  const exactId = sets.find((s) => s.id === wanted);
  if (exactId) return { set: exactId };

  const needle = wanted.toLowerCase();
  const exactName = sets.find((s) => s.agentName.toLowerCase() === needle);
  if (exactName) return { set: exactName };

  // Near-miss on the ID, before falling back to name matching.
  //
  // The error below PRINTS the full id and tells the model "use the id of the
  // one you mean" — and a model that did exactly that, minus the `prop_`
  // prefix, was still refused, because the only substring pass was over agent
  // NAMES. An id that is a substring of the real one (or vice versa) is
  // unambiguous in practice; treat it as the id it obviously is.
  const idNear = sets.filter((s) => {
    const id = s.id.toLowerCase();
    return id.includes(needle) || needle.includes(id);
  });
  if (idNear.length === 1) return { set: idNear[0] };
  if (idNear.length > 1) {
    return {
      error:
        `"${wanted}" matches ${idNear.length} proposal set ids: ` +
        `${JSON.stringify(idNear.map((s) => ({ id: s.id, agent: s.agentName })))}. ` +
        "Use the full id of the one you mean.",
    };
  }

  const partial = sets.filter((s) => s.agentName.toLowerCase().includes(needle));
  if (partial.length === 1) return { set: partial[0] };
  if (partial.length > 1) {
    return {
      error:
        `"${wanted}" matches ${partial.length} proposal sets: ` +
        `${JSON.stringify(partial.map((s) => ({ id: s.id, agent: s.agentName })))}. ` +
        "Use the id of the one you mean.",
    };
  }
  return {
    error:
      `No proposal set matches "${wanted}". Awaiting review: ` +
      `${JSON.stringify(sets.map((s) => ({ id: s.id, agent: s.agentName, files: s.files.size })))}.`,
  };
}

function findFile(set: ProposalSet, wanted: string): ProposedFile | null {
  const needle = wanted.toLowerCase().replace(/\\/g, "/");
  for (const f of set.files.values()) {
    if (f.relPath.toLowerCase().replace(/\\/g, "/") === needle) return f;
  }
  // Suffix match, so "session.ts" finds "src/auth/session.ts".
  const matches = [...set.files.values()].filter((f) =>
    f.relPath.toLowerCase().replace(/\\/g, "/").endsWith(needle),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Where this proposal stands relative to what is on disk RIGHT NOW. Computed,
 * never tracked — so it stays correct whether the user approved a previous
 * accept, denied it, or edited the file themselves in between.
 */
async function fileStatus(
  f: ProposedFile,
): Promise<"pending" | "already-applied" | "stale" | "deleted"> {
  const disk = await readCurrentDiskContent(f.fullPath);
  if (disk === null) return f.type === "create" ? "pending" : "deleted";
  if (disk === f.content) return "already-applied";
  if (disk === (f.baseContent ?? "")) return "pending";
  return "stale";
}

ToolRegistry.register({
  name: "proposals",
  description:
    "Review and land the file changes a writer sub-agent proposed. A writer sub-agent never writes: its edits are captured, and you decide file by file. " +
    'Identify a set with `proposal`: its id, the sub-agent\'s name, or part of that name. ' +
    'operation:"list" — every set awaiting review, with each file\'s +/- counts and whether it is still pending. ' +
    'operation:"show" — the unified diff for one `file` (or all files in the set when `file` is omitted). ' +
    'operation:"accept" — land ONE `file` exactly as proposed. You are not re-typing it: the harness writes the sub-agent\'s own bytes, and the change still passes the normal approval gate (a file that is not already allowed will ask the user). Batch several accept calls in one response. ' +
    'operation:"reject" — drop one `file` with a `reason`; nothing is written. ' +
    "REVIEW BEFORE YOU ACCEPT: read each diff, and if something is wrong say what. To fix a mostly-right change, accept it and then make a normal edit_file on top — do not retype it, and do not reject work that is 95% correct. Finish reviewing a set before you go back to the task.",
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  parameters: createParameters(
    {
      operation: {
        type: "string",
        enum: ["list", "show", "accept", "reject"],
        description:
          "list all sets awaiting review, show a file's diff, accept one file (writes it), or reject one file with a reason.",
      },
      proposal: stringParam(
        "Which proposal set: its id, the sub-agent's name, or a distinctive part of that name. Omit only for operation:\"list\".",
      ),
      file: stringParam(
        "Workspace-relative path of the file to show / accept / reject. A unique suffix works (e.g. \"session.ts\").",
      ),
      reason: stringParam(
        "(reject) Why this change is wrong. Recorded so the decision is legible later.",
      ),
    },
    ["operation"],
  ),
  handler: async (args: {
    operation?: string;
    proposal?: string;
    file?: string;
    reason?: string;
    chatMode?: string;
    _chatSessionId?: number;
  }) => {
    const chatId = args._chatSessionId;
    if (chatId == null) {
      return { success: false, error: "No chat session for proposals." };
    }
    const operation = String(args.operation ?? "").toLowerCase();

    // Defense in depth. `accept` hands the interceptor an edit_file envelope
    // directly, so it never passes through edit_file's own mode check — without
    // this, a read-only mode could land workspace writes through a sub-agent.
    // The mode allowlist already withholds this tool outside build/debug; this
    // fails closed if that ever drifts.
    if (
      (operation === "accept" || operation === "reject") &&
      (args.chatMode === "ask" || args.chatMode === "plan")
    ) {
      return {
        success: false,
        denied: true,
        error: `Proposals can't be accepted or rejected in ${args.chatMode} mode — it doesn't modify the workspace. Switch to Build or Debug.`,
      };
    }

    if (operation === "list") {
      const sets = listProposalSetsForChat(chatId);
      if (sets.length === 0) {
        return {
          success: true,
          count: 0,
          note: "No sub-agent proposals are awaiting review.",
        };
      }
      const conflicts = findProposalConflicts(sets);
      const out = [];
      for (const set of sets) {
        const files = [];
        for (const f of set.files.values()) {
          const { added, removed } = formatUnifiedDiff(
            f.relPath,
            f.baseContent ?? "",
            f.content,
            1,
          );
          files.push({
            file: f.relPath,
            type: f.type,
            added,
            removed,
            status: await fileStatus(f),
          });
        }
        out.push({ proposal: set.id, agent: set.agentName, files });
      }
      return {
        success: true,
        count: sets.length,
        proposals: out,
        ...(conflicts.length > 0
          ? {
              conflicts: conflicts.map((c) => ({
                file: c.relPath,
                agents: c.agents,
                overlapping: c.overlapping,
                note: c.overlapping
                  ? "These sub-agents changed the same lines — pick one, or write your own version."
                  : "Different parts of the same file — accepting both works; the second rebases onto the first.",
              })),
            }
          : {}),
      };
    }

    const wanted = String(args.proposal ?? "").trim();
    if (!wanted) {
      return {
        success: false,
        error: `operation:"${operation}" requires \`proposal\` (a set id, or the sub-agent's name).`,
      };
    }
    const resolved = resolveSet(chatId, wanted);
    if ("error" in resolved) return { success: false, error: resolved.error };
    const set = resolved.set;

    if (operation === "show") {
      if (!args.file?.trim()) {
        const views = buildProposalFileViews(set);
        return {
          success: true,
          proposal: set.id,
          agent: set.agentName,
          files: views.map((v) => ({
            file: v.relPath,
            type: v.type,
            added: v.added,
            removed: v.removed,
            diff: v.diff,
          })),
        };
      }
      const f = findFile(set, args.file.trim());
      if (!f) {
        return {
          success: false,
          error: `"${args.file}" is not in this set. Files: ${JSON.stringify([...set.files.values()].map((x) => x.relPath))}.`,
        };
      }
      const { text, added, removed } = formatUnifiedDiff(
        f.relPath,
        f.baseContent ?? "",
        f.content,
      );
      return {
        success: true,
        proposal: set.id,
        file: f.relPath,
        type: f.type,
        added,
        removed,
        status: await fileStatus(f),
        diff: text,
      };
    }

    if (operation === "reject") {
      const f = args.file?.trim() ? findFile(set, args.file.trim()) : null;
      if (!f) {
        return {
          success: false,
          error: `operation:"reject" requires a \`file\` from this set: ${JSON.stringify([...set.files.values()].map((x) => x.relPath))}.`,
        };
      }
      set.files.delete(f.fullPath);
      const remaining = set.files.size;
      if (remaining === 0) deleteProposalSet(set.id);
      return {
        success: true,
        rejected: f.relPath,
        reason: args.reason?.trim() || "(no reason given)",
        remaining,
        note:
          remaining === 0
            ? "Nothing was written. That was the last file in the set."
            : `Nothing was written for that file. ${remaining} file(s) still awaiting your review.`,
      };
    }

    if (operation !== "accept") {
      return {
        success: false,
        error: `Unknown operation "${operation}". Use list | show | accept | reject.`,
      };
    }

    const f = args.file?.trim() ? findFile(set, args.file.trim()) : null;
    if (!f) {
      return {
        success: false,
        error: `operation:"accept" requires a \`file\` from this set: ${JSON.stringify([...set.files.values()].map((x) => x.relPath))}.`,
      };
    }

    const base = f.baseContent ?? "";
    const disk = await readCurrentDiskContent(f.fullPath);

    if (disk === null && f.type === "update") {
      return {
        success: false,
        error: `${f.relPath} no longer exists — it was deleted after the sub-agent read it. Nothing was written.`,
      };
    }

    // Re-anchor onto what is on disk NOW. Identical disk → the proposal lands
    // byte-for-byte; moved disk → rebase if every hunk still matches, refuse if
    // any doesn't. Never a silent merge over a real conflict.
    const rebase = rebaseOntoCurrent(base, f.content, disk ?? "");
    if (!rebase.ok) {
      return {
        success: false,
        operation: "proposals",
        error:
          `Cannot accept ${f.relPath}: ${rebase.reason} Nothing was written. ` +
          "Re-read the file and either make the change yourself, or delegate it again against the current content.",
        failing_hunks: rebase.failingHunks,
      };
    }

    // The interceptor routes on `operation`, so this IS an edit_file approval —
    // same gate, same card, same write path as if the main agent had typed it.
    return {
      __permission_required: true,
      operation: "edit_file",
      preview: {
        path: f.relPath,
        content: rebase.content,
        ...(disk !== null ? { oldContent: disk } : {}),
        description: rebase.rebased
          ? `Accepted from sub-agent "${set.agentName}" (rebased onto your newer version)`
          : `Accepted from sub-agent "${set.agentName}"`,
        type: disk === null ? ("create" as const) : ("update" as const),
        lines: rebase.content.split("\n").length,
      },
      reasoning: `Applying ${set.agentName}'s proposed change to ${f.relPath}`,
    };
  },
});
