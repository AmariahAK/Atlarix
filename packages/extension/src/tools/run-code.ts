/**
 * `run_code` — the extension's answer to "make me a PDF of this".
 *
 * ══ THE PROBLEM IT EXISTS FOR ══
 *
 * The extension could READ .docx, .xlsx, .pptx, .odt, .epub, PDFs and every
 * text format, and could produce exactly one thing: an HTML relic. Asked for a
 * CSV, a spreadsheet or a report it had nothing to hand over, which is a strange
 * shape for an agent — fluent at taking files in, mute at giving them back.
 *
 * ══ WHY ONE CODE TOOL AND NOT A WRITER PER FORMAT ══
 *
 * The owner's instruction is the design, and it is the opposite of building
 * writers: "if we try and do a global fix we will never catch up, just give it
 * the coding sandbox and allow it to handle the rest dynamically". So there is
 * no xlsx writer here, no pdf writer, no csv writer. There is a sandbox, and the
 * model writes whatever the format needs — which is also the only approach that
 * answers a request for a format nobody thought of.
 *
 * It is the same shape Claude's analysis tool and ChatGPT's Code Interpreter
 * have, with one difference worth being clear about: theirs run server-side in a
 * container with a package manager, and this runs in the user's own browser with
 * no network and no libraries. That rules out `pip install`; it also means no
 * service to run, nothing to meter, nothing that works only while signed in, and
 * the user's files never leave their machine.
 *
 * ══ WHAT THE MODEL CANNOT DO WITH IT ══
 *
 * The code runs in a worker inside a manifest-sandboxed page: an opaque origin
 * with no `chrome.*`, no DOM, no extension storage, no site grants, and
 * `connect-src 'none'`. Measured rather than assumed — `fetch` inside that
 * worker rejects. So model-authored code cannot read the user's session, cannot
 * touch a page, and cannot send a byte anywhere. A file reaches the user only by
 * their own click on Download.
 */

import { wrapUntrustedData } from "@/lib/streaming/untrusted-data";
import { getAttachment, listAttachments } from "../attachments/store";
import {
  findFileByName,
  formatSize,
  listFiles,
  madeFilesNote,
  putFiles,
  type MadeFile,
} from "../files/store";
import { runInSandbox } from "../sandbox/run";
import type { SandboxInput } from "../sandbox/worker";
import type { ToolContext, ToolOutcome } from "./dispatch";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Types whose bytes are worth also handing over as a string. */
function isTexty(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "image/svg+xml"
  );
}

/**
 * Turn the names the model asked for into bytes it can read.
 *
 * RESOLVED BY NAME FIRST, because a name is what the model has. An attachment
 * has an id too and `read_attachment` takes one, so ids are accepted as well —
 * but requiring one here would mean the model had to go and look it up before it
 * could open a file it has been discussing by name for six turns.
 */
async function resolveInputs(
  wanted: string[],
  ctx: ToolContext,
): Promise<{ inputs: SandboxInput[] } | { missing: string; known: string[] }> {
  const attachments = await listAttachments(ctx.sessionId);
  const made = listFiles(ctx.sessionId);
  const inputs: SandboxInput[] = [];

  for (const raw of wanted) {
    const name = raw.trim();
    if (!name) continue;

    const file = findFileByName(ctx.sessionId, name);
    if (file) {
      inputs.push({
        name: file.name,
        type: file.mime,
        bytes: file.bytes,
        text: isTexty(file.mime) ? new TextDecoder().decode(file.bytes) : null,
      });
      continue;
    }

    const attachment =
      (await getAttachment(ctx.sessionId, name)) ??
      attachments.find((a) => a.name === name) ??
      null;
    if (attachment) {
      inputs.push({
        name: attachment.name,
        type: attachment.type,
        bytes: new TextEncoder().encode(attachment.body),
        // An attachment is STORED AS TEXT — `ooxml.ts` extracted it when the
        // user attached it — so the text is the real content and the bytes are
        // its encoding, not the original file's. Said plainly in the tool
        // description, because code that expects PNG bytes from a .png
        // attachment would otherwise fail in a puzzling way.
        text: attachment.body,
      });
      continue;
    }

    return {
      missing: name,
      known: [...attachments.map((a) => a.name), ...made.map((f) => f.name)],
    };
  }

  return { inputs };
}

export async function runCode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const code = str(args.code);
  if (!code.trim()) {
    return { content: "Nothing ran — `code` was empty.", label: "Ran nothing" };
  }

  const wanted = Array.isArray(args.inputs)
    ? args.inputs.filter((v): v is string => typeof v === "string")
    : [];

  const resolved = await resolveInputs(wanted, ctx);
  if ("missing" in resolved) {
    return {
      content:
        `There is nothing called "${resolved.missing}" in this conversation. ` +
        (resolved.known.length > 0
          ? `Available: ${resolved.known.join(", ")}.`
          : "Nothing has been attached and nothing has been made yet.") +
        ' Names are exact. Leave "inputs" out entirely if the code does not ' +
        "need a file.",
      label: "No such file",
    };
  }

  const started = Date.now();
  let outcome;
  try {
    outcome = await runInSandbox({ code, inputs: resolved.inputs });
  } catch (err) {
    // Only a sandbox that will not mount reaches here, and that is a fault in
    // Atlarix rather than in the model's code — so it says so, and says not to
    // retry, rather than inviting a loop of identical attempts.
    return {
      content:
        `The code sandbox could not start: ${err instanceof Error ? err.message : String(err)}. ` +
        `This is a fault in Atlarix, not in your code — do not retry. Tell the ` +
        `user what you were trying to build.`,
      label: "Sandbox unavailable",
    };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const made: MadeFile[] =
    outcome.files.length > 0 ? putFiles(ctx.sessionId, outcome.files) : [];

  const parts: string[] = [];

  if (outcome.stdout) {
    // WRAPPED, even though the model wrote the code that printed it. The code
    // may have embedded text the agent read from a page, and re-surfacing that
    // unwrapped would launder it out of the envelope `read_page` put it in.
    // `wrapUntrustedData` nests safely, so wrapping something already wrapped
    // costs a few characters and never breaks the boundary.
    parts.push(
      wrapUntrustedData("code output", outcome.stdout) +
        (outcome.truncated
          ? "\n(Output was cut off at the limit — print less, or write it to a file.)"
          : ""),
    );
  }

  if (outcome.value !== null) parts.push(`Returned: ${outcome.value}`);

  if (!outcome.ok) {
    parts.unshift(`Your code failed after ${seconds}s.\n\n${outcome.error ?? ""}`);
    if (made.length > 0) {
      parts.push(
        `It did produce ${made.length} file${made.length === 1 ? "" : "s"} before ` +
          `failing, and ${made.length === 1 ? "it is" : "they are"} kept: ` +
          `${madeFilesNote(made)}`,
      );
    }
    return {
      content: parts.join("\n\n"),
      label: made.length > 0 ? "Code failed part-way" : "Code failed",
      files: made.length > 0 ? made : undefined,
    };
  }

  if (made.length > 0) {
    parts.push(madeFilesNote(made));
  } else if (!outcome.stdout && outcome.value === null) {
    // A run that printed nothing, returned nothing and made nothing is almost
    // always a forgotten `emit`. Saying "ran fine" would be true and useless.
    parts.push(
      `The code ran without error but produced nothing — no output and no ` +
        `file. If you meant to hand the user a file, call ` +
        `emit("name.ext", data) with it.`,
    );
  }

  return {
    content: parts.join("\n\n"),
    label:
      made.length > 0
        ? `Made ${made.map((f) => f.name).join(", ")} (${formatSize(
            made.reduce((n, f) => n + f.size, 0),
          )})`
        : `Ran code in ${seconds}s`,
    files: made.length > 0 ? made : undefined,
  };
}
