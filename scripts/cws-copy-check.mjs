#!/usr/bin/env node
/**
 * Measure the Chrome Web Store copy in `cws/` against the limits and the one
 * policy that has actually rejected this extension.
 *
 * ══ WHY THIS EXISTS ══
 *
 * Two failures, both real, both invisible in a diff:
 *
 * 1. **v1.0.0 was rejected for "Spam and Placement in the Store — excessive
 *    keywords"**, quoting a description line that named six file formats by
 *    product name. It was written as a capability and read as keyword stuffing.
 *    `docs/TODO.md` records that `DESCRIPTION.txt` "now carries a check" for
 *    this. It did not — the claim was a sentence in a markdown file, and a
 *    sentence is not a check. This is the check.
 *
 * 2. **The single-purpose block had drifted to ~1,125 characters**, over the
 *    1,000-character field limit, which means what is in the dashboard was
 *    never this file verbatim: someone trimmed it at paste time and never wrote
 *    the trim back. A file that claims to be the source of a form field and
 *    silently is not is worse than no file, because the next person edits it
 *    and believes they have changed the submission.
 *
 * Neither is caught by a build, a type-check or a test, because this copy is
 * pasted into a web form by a human. So it is checked here, and the run is
 * cheap enough to do before every submission.
 *
 * ══ WHAT IT DOES NOT CHECK ══
 *
 * That the dashboard matches these files. Nothing can — the Store API sets the
 * PACKAGE and nothing else; description, screenshots and justifications are not
 * readable or settable through it. That gap is the reason for failure 2, and
 * the only defence is re-pasting deliberately.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "cws-copy-check";

/** Chrome Web Store field limits. */
const FIELD_LIMIT = 1000;
const DESCRIPTION_LIMIT = 16_000;

/**
 * Product and format names, which is what the rejection was about.
 *
 * NOT a blocklist — every one of these is a legitimate word and several appear
 * in the current copy. The policy is about DENSITY: a line that names three or
 * more of them reads as keyword stuffing however it was meant, and the rejected
 * line named six.
 */
const PRODUCT_WORDS = [
  "pdf", "pdfs", "word", "excel", "powerpoint", "opendocument", "epub",
  "csv", "xlsx", "docx", "pptx", "odt", "ods", "zip", "png", "jpeg",
  "markdown", "keynote", "numbers", "pages",
];
const MAX_PRODUCTS_PER_LINE = 2;

const failures = [];
const fail = (message) => failures.push(message);

function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    fail(`${rel} is missing — the dashboard copy has no source of truth`);
    return null;
  }
  return fs.readFileSync(file, "utf8");
}

// ---------------------------------------------------------------------------
// The privacy form's fenced blocks
// ---------------------------------------------------------------------------

const form = read("cws/PRIVACY-FORM.md");
if (form) {
  // Each pasteable block is a fenced section under a `## ` heading. Anything
  // between the heading and the fence is prose ABOUT the field and is not part
  // of what gets pasted.
  const blocks = [...form.matchAll(/^## (.+?)$\n(?:(?!^## )[\s\S])*?```\n([\s\S]*?)```/gm)];

  if (blocks.length === 0) {
    fail("cws/PRIVACY-FORM.md has no fenced blocks — has its shape changed?");
  }

  for (const [, heading, body] of blocks) {
    const text = body.replace(/\n+$/, "");
    const n = text.length;
    const over = n > FIELD_LIMIT;
    console.log(
      `[${TAG}] ${String(n).padStart(5)}  ${over ? "OVER" : "ok  "}  ${heading}`,
    );
    if (over) {
      fail(
        `"${heading}" is ${n} characters, over the ${FIELD_LIMIT} limit by ` +
          `${n - FIELD_LIMIT}. It cannot be pasted whole, and a field trimmed ` +
          `by hand at paste time is how this file stopped matching the ` +
          `dashboard last time.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The description, and the line shape that was rejected
// ---------------------------------------------------------------------------

const description = read("cws/DESCRIPTION.txt");
if (description) {
  console.log(
    `[${TAG}] ${String(description.length).padStart(5)}  ` +
      `${description.length > DESCRIPTION_LIMIT ? "OVER" : "ok  "}  DESCRIPTION.txt`,
  );
  if (description.length > DESCRIPTION_LIMIT) {
    fail(`cws/DESCRIPTION.txt is ${description.length} characters, over ${DESCRIPTION_LIMIT}.`);
  }

  description.split("\n").forEach((line, i) => {
    const hits = PRODUCT_WORDS.filter((w) =>
      new RegExp(`\\b${w}\\b`, "i").test(line),
    );
    if (hits.length > MAX_PRODUCTS_PER_LINE) {
      fail(
        `cws/DESCRIPTION.txt line ${i + 1} names ${hits.length} products or ` +
          `formats (${hits.join(", ")}). v1.0.0 was rejected for exactly this ` +
          `shape — "Spam and Placement in the Store — excessive keywords" — on ` +
          `a line naming six. Say what the feature DOES instead of listing what ` +
          `it outputs.\n    ${line.trim()}`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The reviewer's account, which is the likeliest rejection nobody predicts
// ---------------------------------------------------------------------------

const instructions = read("cws/TEST-INSTRUCTIONS.txt");
if (instructions && /<REVIEWER ACCOUNT (EMAIL|PASSWORD)>/.test(instructions)) {
  // A placeholder in the repo is correct — credentials do not belong in git.
  // It is only a problem at the moment of pasting, so this is a reminder rather
  // than a failure.
  console.log(
    `[${TAG}] note: TEST-INSTRUCTIONS.txt still has credential placeholders. ` +
      `Fill them in the dashboard, not in the file. A reviewer who cannot sign ` +
      `in sees an extension that does not work, and the rejection will not ` +
      `mention the account.`,
  );
}

if (failures.length > 0) {
  console.error(`\n[${TAG}] ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(`\n[${TAG}] copy is within every limit and names no line of formats.`);
