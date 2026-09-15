#!/usr/bin/env node
/**
 * One-off outreach: email confirmed Supabase users about the v14.45 free release.
 *
 * Usage (from Atlarix/):
 *   node scripts/send-free-gpt6-email.mjs --dry-run
 *   node scripts/send-free-gpt6-email.mjs --only you@example.com
 *   node scripts/send-free-gpt6-email.mjs
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Campaign-specific log so this send does NOT dedup against earlier campaigns.
// MUST differ from every previous campaign file, or everyone who received the
// 2026-08 email is silently skipped as "already sent".
const LOG_FILE = join(ROOT, "scripts", ".outreach-free-gpt6-2026-09.log.json");

const EXCLUDED_EMAILS = new Set(
  ["amariah.abish@gmail.com", "amani.kamau06@gmail.com"].map((e) =>
    e.toLowerCase(),
  ),
);

const SUBJECT = "Atlarix is free now, and it runs GPT-6 Astra";
const PREFERRED_FROM = "Amariah <amariah@atlarix.dev>";
const DEFAULT_REPLY_TO = "amariah@atlarix.dev";
// 600ms put all 96 out in under a minute, which from a domain that rarely sends
// bulk mail is the shape spam filters look for. 5s spreads the batch over ~8
// minutes — still one sitting, far less like a blast.
const THROTTLE_MS = 5000;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE = args.has("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY_EMAIL =
  onlyIdx >= 0 ? process.argv[onlyIdx + 1]?.trim().toLowerCase() : null;
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : null;

function loadEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    console.error("Missing Atlarix/.env");
    process.exit(1);
  }
  dotenv.config({ path: envPath });
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

/**
 * Capitalise only an all-lowercase token, e.g. "dhulii" → "Dhulii".
 *
 * Left alone otherwise, because anything with existing capitals is either already
 * right or deliberately styled ("McPherson", "de Souza", "iain") and "fixing" it
 * is how a personal email starts looking generated.
 */
function tidyName(name) {
  return /^[a-z][a-z'-]*$/.test(name)
    ? name.charAt(0).toUpperCase() + name.slice(1)
    : name;
}

function deriveFirstName(user) {
  const meta = user.user_metadata || {};
  if (typeof meta.first_name === "string" && meta.first_name.trim()) {
    return tidyName(meta.first_name.trim());
  }
  if (typeof meta.full_name === "string" && meta.full_name.trim()) {
    return tidyName(meta.full_name.trim().split(/\s+/)[0]);
  }
  if (typeof meta.name === "string" && meta.name.trim()) {
    return tidyName(meta.name.trim().split(/\s+/)[0]);
  }
  // NOTHING is guessed from the email address. The old version capitalised the
  // local part whenever it was 2+ alphabetic characters, which passes the check
  // and still produces "Hey Acowpbackup," and "Hey Jnadal," — the same
  // reads-as-spam failure the check was added to prevent, just less obvious than
  // "Hey 3104560364,".
  //
  // Measured on the newest 40 confirmed users before removing it: 38 had a real
  // name in their OAuth metadata, and the only 2 that did not were both of the
  // bad cases above. So the fallback bought two wrong names and no right ones.
  // "there" reads like a human wrote it; a mangled handle does not.
  return "there";
}

/**
 * Campaign 2026-09: the app went free, and Core runs a frontier lineup.
 *
 * The 2026-08 campaign asked "what stopped you?". This one answers the two most
 * common reasons anyone gives for not staying with a tool like this — it cost
 * money, and the models were not the ones they actually want — because both
 * genuinely changed in v14.45.
 *
 * WRITTEN FOR PEOPLE WHO DO NOT READ CHANGELOGS. Most of this list signed up once
 * and left; they do not know what Atlarix Core is, and they will not learn it from
 * an email. So: no tier names, no wallet mechanics, no feature matrix. Three facts
 * and a link.
 *
 * DELIBERATELY NOT IN HERE:
 *   - The size of the Pro allowance in dollars. Publishing it prices our own cost
 *     structure and invites a "$19 for $10" comparison — the rule at the top of
 *     `src/shared/billing_copy.ts`.
 *   - The security fixes. "A repo can no longer override Atlarix's instructions" is
 *     real and worth shipping, but to someone who has not opened the app in months
 *     it reads as "there was a hole", which is a worse first impression than silence.
 *     It is in the changelog for anyone who looks.
 *   - "You never came back." True of most of this list and wrong for some, and being
 *     wrong to someone's face costs more than the line is worth.
 *
 * OWNER'S CALL, recorded because both are deliberate:
 *   - It NAMES two models (Astra, Terra). The lineup is remote config and can change the
 *     week after this sends, so this email dates itself. Accepted: naming them is the
 *     news, and an email is a moment rather than a document.
 *   - It PROMISES a browser extension. Forward-looking, to every user, hedged as "still
 *     in development".
 *
 * The cross-tool paragraph is accurate, and checked against the code rather than the
 * roadmap: AGENTS.md § "Other tools' configuration" (commit 9b1ac1dc) tells the agent to
 * never silently follow another tool's rules file, to ask, and to offer to write the
 * answer into `.atlarix/rules/` so it stops asking; `readProjectInstructions` reads
 * AGENTS.md and CLAUDE.md natively (read-only, never copied); and `manage_mcp_server`
 * proposes servers from any config shape — its description names `.mcp.json` and
 * `.cursor/mcp.json` — with per-server approval and no unilateral writes. It works for
 * Cursor through the GENERIC path, not a per-vendor parser: that importer was dropped on
 * purpose, which is what makes "or something I've never heard of" true rather than
 * marketing.
 */
function buildBodies(firstName) {
  const text = `Hey ${firstName},

Amariah here — I build Atlarix. Real email, replies come to me.

To everyone who uses Atlarix — thank you for making it what it is today. Its growth, the mentions out in the wild, the ways you've put it to work — thank you, genuinely, for all of it. Here's what's new.

GPT-6 Astra is in Atlarix. It's in the model picker now, with GPT-5.6 Terra alongside it for quicker everyday work — reach for Astra when you want deep reasoning, Terra when you just want it done. No API key from anyone required: sign in and pick one.

The app is free. Not a trial, not a limited tier — every feature, for everyone. Bring your own projects and use the whole thing without paying for the app at all. The only thing that costs money is inference on the hosted models — and you can skip even that: plug in your own OpenAI or Anthropic key, or point it at a local model (Ollama, LM Studio), and Atlarix costs you nothing, ever. If you'd rather use the hosted models, top up a balance from $10 and the app shows you what each reply cost.

It picks up your existing setup — including from other tools. Atlarix reads the workflows, MCP servers, skills and rules you already have and keeps working on them, and it can carry across a setup from Claude Code, Codex, Cursor or something I've never heard of. It proposes what it finds and acts once you approve — it won't adopt another tool's config or connect anything on its own.

Among a lot of other updates — the money side is honest now (stop the agent mid-answer and you're billed for what it actually produced; a dropped connection reconnects instead of losing the run), and you can teach it your project's conventions with a markdown file that travels with the repo for your whole team.

One thing that's coming: a browser extension that lets Atlarix work in the browser you already use — the tabs you're logged into, not a separate window. Still in development; I'll tell you when it lands.

Download or update: https://atlarix.dev

To you who stayed and made Atlarix what it is — thank you, and here's to many more achievements ahead.

Amariah
I build Atlarix

Don't want emails like this? Reply "stop" and I won't send another.`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#0f172a;max-width:560px;">
<p>Hey ${escapeHtml(firstName)},</p>
<p>Amariah here — I build Atlarix. Real email, replies come to me.</p>
<p>To everyone who uses Atlarix — thank you for making it what it is today. Its growth, the mentions out in the wild, the ways you've put it to work — thank you, genuinely, for all of it. Here's what's new.</p>
<p><strong>GPT-6 Astra is in Atlarix.</strong> It's in the model picker now, with GPT-5.6 Terra alongside it for quicker everyday work — reach for Astra when you want deep reasoning, Terra when you just want it done. No API key from anyone required: sign in and pick one.</p>
<p><strong>The app is free.</strong> Not a trial, not a limited tier — every feature, for everyone. Bring your own projects and use the whole thing without paying for the app at all. The only thing that costs money is inference on the hosted models — and you can skip even that: plug in your own OpenAI or Anthropic key, or point it at a local model (Ollama, LM Studio), and Atlarix costs you nothing, ever. If you'd rather use the hosted models, top up a balance from $10 and the app shows you what each reply cost.</p>
<p><strong>It picks up your existing setup — including from other tools.</strong> Atlarix reads the workflows, MCP servers, skills and rules you already have and keeps working on them, and it can carry across a setup from Claude Code, Codex, Cursor or something I've never heard of. It proposes what it finds and acts once you approve — it won't adopt another tool's config or connect anything on its own.</p>
<p>Among a lot of other updates — the money side is honest now (stop the agent mid-answer and you're billed for what it actually produced; a dropped connection reconnects instead of losing the run), and you can teach it your project's conventions with a markdown file that travels with the repo for your whole team.</p>
<p>One thing that's coming: a browser extension that lets Atlarix work in the browser you already use — the tabs you're logged into, not a separate window. Still in development; I'll tell you when it lands.</p>
<p><a href="https://atlarix.dev">Download or update Atlarix</a></p>
<p>To you who stayed and made Atlarix what it is — thank you, and here's to many more achievements ahead.</p>
<p>Amariah<br />I build Atlarix</p>
<p style="color:#94a3b8;font-size:12px;">Don't want emails like this? Reply "stop" and I won't send another.</p>
</body></html>`;

  return { text, html };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadSentLog() {
  if (!existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(await readFile(LOG_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function appendSentLog(entry) {
  const prev = await loadSentLog();
  prev.push(entry);
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await writeFile(LOG_FILE, JSON.stringify(prev, null, 2));
}

async function fetchAllUsers(supabase) {
  const all = [];
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw error;
    const batch = data?.users ?? [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

function buildRecipientList(users) {
  const seen = new Set();
  const recipients = [];

  for (const user of users) {
    const email = user.email?.trim().toLowerCase();
    if (!email) continue;
    if (!user.email_confirmed_at) continue;
    // `--only <address>` overrides the exclusion list. Naming one address is an
    // explicit instruction, and the excluded addresses are the maintainer's own —
    // which are exactly the ones you want to send a probe to before a real batch.
    // Without this, `--only amani.kamau06@gmail.com` reported "no confirmed
    // recipient found" and sent nothing, which reads like the account is missing.
    if (EXCLUDED_EMAILS.has(email) && email !== ONLY_EMAIL) continue;
    if (seen.has(email)) continue;
    seen.add(email);

    recipients.push({
      email,
      firstName: deriveFirstName(user),
      userId: user.id,
      createdAt: user.created_at ?? null,
      // Only updates on a NEW sign-in — a cached session that silently refreshes
      // does not bump it. Shown in --dry-run as a sanity check on who is being
      // targeted, never used to decide anything.
      lastSignInAt: user.last_sign_in_at ?? null,
    });
  }

  // NEWEST SIGNUP FIRST, so `--limit N` means "the N most recent signups".
  // It used to sort by email, which made `--limit` select a semi-random slice —
  // fine for a send-to-everyone campaign, wrong for any campaign aimed at recent
  // signups, and silently so.
  recipients.sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  return recipients;
}

async function sendViaResend({
  apiKey,
  from,
  replyTo,
  to,
  subject,
  text,
  html,
}) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: replyTo,
      subject,
      text,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: data.message || String(res.status), data };
  }
  return { ok: true, id: data.id };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  loadEnv();

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  // New Supabase API-key system: the secret key replaces the legacy service_role JWT.
  const serviceKey =
    process.env.NEXT_PUBLIC_SUPABASE_SECRET_KEY?.trim() ||
    requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = requireEnv("RESEND_API_KEY");

  const replyTo = process.env.OUTREACH_REPLY_TO?.trim() || DEFAULT_REPLY_TO;
  const preferredFrom = process.env.OUTREACH_FROM?.trim() || PREFERRED_FROM;
  const fallbackFrom = process.env.EMAIL_SOURCE?.trim();

  if (!fallbackFrom && !preferredFrom) {
    console.error("Set OUTREACH_FROM or EMAIL_SOURCE in .env");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("Fetching users from Supabase...");
  const users = await fetchAllUsers(supabase);
  console.log(`Total auth users: ${users.length}`);

  let recipients = buildRecipientList(users);
  if (ONLY_EMAIL) {
    recipients = recipients.filter((r) => r.email === ONLY_EMAIL);
    if (!recipients.length) {
      console.error(`No confirmed recipient found for --only ${ONLY_EMAIL}`);
      process.exit(1);
    }
  }
  if (LIMIT != null && Number.isFinite(LIMIT) && LIMIT > 0) {
    recipients = recipients.slice(0, LIMIT);
  }

  const sentLog = await loadSentLog();
  const sentEmails = new Set(
    sentLog
      .filter((e) => e.status === "sent")
      .map((e) => e.email?.toLowerCase()),
  );

  const pending = FORCE
    ? recipients
    : recipients.filter((r) => !sentEmails.has(r.email));

  console.log(
    `Recipients after filters (excl. your 2 emails): ${recipients.length}`,
  );
  console.log(`Already sent (skipped): ${recipients.length - pending.length}`);
  console.log(`To send this run: ${pending.length}`);

  if (DRY_RUN) {
    console.log("\n--- DRY RUN (no emails sent) ---\n");
    for (const r of pending.slice(0, 5)) {
      const { text } = buildBodies(r.firstName);
      console.log(`To: ${r.email}`);
      console.log(`First name: ${r.firstName}`);
      console.log(text);
      console.log("---");
    }
    if (pending.length > 5) {
      console.log(`... and ${pending.length - 5} more`);
    }
    console.log("\nAll pending emails:");
    for (const r of pending) console.log(`  ${r.email}`);
    return;
  }

  if (!pending.length) {
    console.log("Nothing to send.");
    return;
  }

  let from = preferredFrom;
  let useFallbackFrom = false;

  // Probe first send with preferred From; fall back to EMAIL_SOURCE if domain/sender rejected
  const probe = pending[0];
  const probeBodies = buildBodies(probe.firstName);
  console.log(`Probing sender with ${probe.email} using From: ${from}`);

  let probeResult = await sendViaResend({
    apiKey: resendKey,
    from,
    replyTo,
    to: probe.email,
    subject: SUBJECT,
    ...probeBodies,
  });

  if (!probeResult.ok && fallbackFrom && fallbackFrom !== from) {
    console.warn(
      `Preferred From failed (${probeResult.error}); using EMAIL_SOURCE + reply_to`,
    );
    from = fallbackFrom;
    useFallbackFrom = true;
    probeResult = await sendViaResend({
      apiKey: resendKey,
      from,
      replyTo,
      to: probe.email,
      subject: SUBJECT,
      ...probeBodies,
    });
  }

  if (!probeResult.ok) {
    console.error("Probe send failed:", probeResult.error, probeResult.data);
    process.exit(1);
  }

  await appendSentLog({
    email: probe.email,
    resendId: probeResult.id,
    sentAt: new Date().toISOString(),
    status: "sent",
    from,
    replyTo,
  });
  console.log(
    `Probe OK (id=${probeResult.id})${useFallbackFrom ? " [fallback From]" : ""}`,
  );

  const rest = pending.slice(1);
  let sent = 1;
  let failed = 0;

  for (const r of rest) {
    await sleep(THROTTLE_MS);
    const bodies = buildBodies(r.firstName);
    const result = await sendViaResend({
      apiKey: resendKey,
      from,
      replyTo,
      to: r.email,
      subject: SUBJECT,
      ...bodies,
    });

    if (result.ok) {
      sent += 1;
      await appendSentLog({
        email: r.email,
        resendId: result.id,
        sentAt: new Date().toISOString(),
        status: "sent",
        from,
        replyTo,
      });
      console.log(`[${sent}/${pending.length}] Sent ${r.email}`);
    } else {
      failed += 1;
      await appendSentLog({
        email: r.email,
        sentAt: new Date().toISOString(),
        status: "failed",
        error: result.error,
        from,
        replyTo,
      });
      console.error(`FAILED ${r.email}: ${result.error}`);
    }
  }

  console.log(
    `\nDone. Sent: ${sent}, Failed: ${failed}, Total targeted: ${pending.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
