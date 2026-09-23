#!/usr/bin/env node
/**
 * Outreach 2026-09-23: Atlarix Auto — free models, no API key, no credit (v14.51.0).
 *
 * Usage (from Atlarix/):
 *   npm run email:atlarix-auto:dry-run
 *   npm run email:atlarix-auto -- --only you@example.com
 *   npm run email:atlarix-auto
 *
 * NEVER EMAILS ANYONE ON THE SUPPRESSION LIST — `scripts/.email-suppression.json`
 * (gitignored: it holds people's addresses, and this repo is sometimes public).
 * People who replied "stop" or asked for their account to be deleted go there,
 * and every future campaign script must read it too.
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
const LOG_FILE = join(ROOT, "scripts", ".outreach-atlarix-auto-2026-09-23.log.json");
const SUPPRESSION_FILE = join(ROOT, "scripts", ".email-suppression.json");

const EXCLUDED_EMAILS = new Set(
  ["amariah.abish@gmail.com", "amani.kamau06@gmail.com"].map((e) =>
    e.toLowerCase(),
  ),
);

const SUBJECT = "Atlarix now has free models: no API key, no credit";
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
 * Campaign 2026-09-23 — the owner's own words, verbatim; only {first_name} is filled.
 * Every claim is true of v14.51.0: free Auto is desktop-only and shared with
 * OpenAI (asked once), paid Auto never trains, BYOK and local are unchanged, the
 * extension runs on paid Auto, and Reviewer is included in Pro ($19/month).
 */
function buildBodies(firstName) {
  const text = `Hey ${firstName},

Amariah here, I build Atlarix. This is a real email, and replies come straight to me.

Short one: you can now use Atlarix without an API key and without paying for a model.

It's called Atlarix Auto. Instead of you choosing a model, Auto picks the right one for each step of the work: planning, building, reviewing, even reading a screenshot or a PDF. On a free account, Auto in the desktop app costs nothing. You get a fair daily allowance that resets every day, and the app shows you when on your own clock.

One thing I want to be upfront about, because privacy is the reason Atlarix exists: free Auto runs on OpenAI's data-sharing program. That's what makes it free, and it means requests you send on free Auto can be used by OpenAI to improve their models. The app tells you this once before you start, and you choose whether to go ahead. If you'd rather keep everything private, you still can:

- Paid Auto (with Pro or credit) is never used for training.
- Your own API keys work exactly as before.
- Local models through Ollama or LM Studio never leave your machine.

To try it:
1. Open Atlarix. It updates itself; if it doesn't, grab the latest from atlarix.dev.
2. If you picked a model before, switch to Auto in the model picker. New installs start on it.
3. Give it a real task on your own code.

If it's been a while: Atlarix is a desktop app where the agent plans, edits your code, runs commands in a sandbox, and runs your tests before it calls anything done. Every change waits for your approval. There's also a Chrome extension (it runs on paid Auto) and Atlarix Reviewer, which reviews your pull requests on Pro ($19/month).

If you try it, hit reply and tell me what worked and what didn't. I read every one.

Amariah Abishai
Atlarix · atlarix.dev

Don't want these emails? Reply "stop" and I'll take you off the list.`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#0f172a;max-width:560px;">
<p>Hey ${escapeHtml(firstName)},</p>
<p>Amariah here, I build Atlarix. This is a real email, and replies come straight to me.</p>
<p>Short one: you can now use Atlarix without an API key and without paying for a model.</p>
<p>It's called <strong>Atlarix Auto</strong>. Instead of you choosing a model, Auto picks the right one for each step of the work: planning, building, reviewing, even reading a screenshot or a PDF. On a free account, Auto in the desktop app costs nothing. You get a fair daily allowance that resets every day, and the app shows you when on your own clock.</p>
<p>One thing I want to be upfront about, because privacy is the reason Atlarix exists: free Auto runs on OpenAI's data-sharing program. That's what makes it free, and it means requests you send on free Auto can be used by OpenAI to improve their models. The app tells you this once before you start, and you choose whether to go ahead. If you'd rather keep everything private, you still can:</p>
<ul>
<li>Paid Auto (with Pro or credit) is never used for training.</li>
<li>Your own API keys work exactly as before.</li>
<li>Local models through Ollama or LM Studio never leave your machine.</li>
</ul>
<p>To try it:</p>
<ol>
<li>Open Atlarix. It updates itself; if it doesn't, grab the latest from <a href="https://atlarix.dev">atlarix.dev</a>.</li>
<li>If you picked a model before, switch to Auto in the model picker. New installs start on it.</li>
<li>Give it a real task on your own code.</li>
</ol>
<p>If it's been a while: Atlarix is a desktop app where the agent plans, edits your code, runs commands in a sandbox, and runs your tests before it calls anything done. Every change waits for your approval. There's also a Chrome extension (it runs on paid Auto) and Atlarix Reviewer, which reviews your pull requests on Pro ($19/month).</p>
<p>If you try it, hit reply and tell me what worked and what didn't. I read every one.</p>
<p>Amariah Abishai<br />Atlarix · <a href="https://atlarix.dev">atlarix.dev</a></p>
<p style="color:#94a3b8;font-size:12px;">Don't want these emails? Reply "stop" and I'll take you off the list.</p>
</body></html>`;

  return { text, html };
}

/** Addresses that must never be emailed again (replied "stop" / asked for deletion). */
async function loadSuppression() {
  if (!existsSync(SUPPRESSION_FILE)) return new Set();
  const raw = JSON.parse(await readFile(SUPPRESSION_FILE, "utf8"));
  const list = Array.isArray(raw) ? raw : (raw.emails ?? []);
  return new Set(
    list
      .map((e) => (typeof e === "string" ? e : e?.email))
      .filter(Boolean)
      .map((e) => e.trim().toLowerCase()),
  );
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

function buildRecipientList(users, suppressed) {
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
    // Permanent, and it beats --only: a suppressed address is never sent to.
    if (suppressed.has(email)) continue;
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

  const suppressed = await loadSuppression();
  console.log(`Suppression list: ${suppressed.size} address(es) never emailed`);
  if (ONLY_EMAIL && suppressed.has(ONLY_EMAIL)) {
    console.error(`${ONLY_EMAIL} is on the suppression list — refusing to send.`);
    process.exit(1);
  }
  let recipients = buildRecipientList(users, suppressed);
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
    `Recipients after filters (excl. your 2 emails and the suppression list): ${recipients.length}`,
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
