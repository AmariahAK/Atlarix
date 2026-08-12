#!/usr/bin/env node
/**
 * One-off outreach: email confirmed Supabase users with a short product question.
 *
 * Usage (from Atlarix/):
 *   node scripts/send-user-feedback-email.mjs --dry-run
 *   node scripts/send-user-feedback-email.mjs --only you@example.com
 *   node scripts/send-user-feedback-email.mjs
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Campaign-specific log so this send does NOT dedup against earlier campaigns.
const LOG_FILE = join(ROOT, "scripts", ".outreach-first-run-2026-08.log.json");

const EXCLUDED_EMAILS = new Set(
  ["amariah.abish@gmail.com", "amani.kamau06@gmail.com"].map((e) => e.toLowerCase()),
);

const SUBJECT = "Windows is fixed, and Atlarix is on the Microsoft Store";
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
const ONLY_EMAIL = onlyIdx >= 0 ? process.argv[onlyIdx + 1]?.trim().toLowerCase() : null;
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
 * Campaign 2026-08: two things that were breaking retention are fixed; ask why people stopped.
 *
 * Written against the data. Of 97 users, 72 never generated a second sign-in, and
 * 6 of the 25 who did signed in twice inside 30 minutes — a first sign-in that
 * failed to stick, not a return. So ~80% had a single session, and subtracting the
 * owner leaves ~15 who ever signed in on a different day. The always-open realtime
 * plan channel shows no persistent floor, so there is no hidden cached-session
 * usage either.
 *
 * Deliberately NOT "you never came back": true for most, wrong for some, and being
 * wrong to someone's face is what kills the "I actually pay attention" premise the
 * whole email rests on. It leads with the two fixes instead, which is both a real
 * reason to write and the likeliest reason people left:
 *
 *   - v14.28.0 — `run_command` was broken on Windows in EVERY prior release
 *     (AppContainer denied reads, so git and bash failed outright). That is the
 *     core loop of an agentic tool, and it predates almost every signup here.
 *   - v14.27.0 — the app could lose credentials and workspaces between launches.
 *     A later sign-in in the auth data is more likely THIS than loyalty.
 *
 * Naming both makes replying easy for anyone who hit them, and neither would ever
 * surface from an open-ended "was it clear what to do".
 */
function buildBodies(firstName) {
  const text = `Hey ${firstName},

Amariah here — I build Atlarix, and this is a real email; replies come straight to me.

I think Atlarix let you down, and I want to know how.

Two things were broken badly enough to make anyone stop, and both are now fixed. On Windows, terminal commands and git were failing outright — the main thing Atlarix does. And on every platform, the app could lose your sign-in and your workspace list between launches. If you came back once, found yourself logged out with your workspaces gone, and didn't bother again: that was a bug, not you.

Atlarix is on the Microsoft Store now too, so on Windows it installs with no security warning and keeps itself updated: https://apps.microsoft.com/detail/9p3rr11dvzpw

So — what stopped you?

Anything at all: it didn't do what you expected, you couldn't tell what to do first, it wanted an API key or credit before it was useful, something broke, or you got busy and forgot. "I opened it, poked around, closed it" is a complete and genuinely useful answer — it tells me exactly what to fix.

One line back is plenty. I read every reply myself.

Amariah
I build Atlarix

PS — on Windows, the Store build is the one to have: uninstall the copy you've got and reinstall from the link above. Your projects are folders on your disk, so they stay put.

Don't want emails like this? Reply "stop" and I won't send another.`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#0f172a;max-width:560px;">
<p>Hey ${escapeHtml(firstName)},</p>
<p>Amariah here — I build Atlarix, and this is a real email; replies come straight to me.</p>
<p>I think Atlarix let you down, and I want to know how.</p>
<p>Two things were broken badly enough to make anyone stop, and both are now fixed. On Windows, terminal commands and git were failing outright — the main thing Atlarix does. And on every platform, the app could lose your sign-in and your workspace list between launches. If you came back once, found yourself logged out with your workspaces gone, and didn't bother again: that was a bug, not you.</p>
<p>Atlarix is on the <a href="https://apps.microsoft.com/detail/9p3rr11dvzpw">Microsoft Store</a> now too, so on Windows it installs with no security warning and keeps itself updated.</p>
<p>So — <strong>what stopped you?</strong></p>
<p>Anything at all: it didn't do what you expected, you couldn't tell what to do first, it wanted an API key or credit before it was useful, something broke, or you got busy and forgot. "I opened it, poked around, closed it" is a complete and genuinely useful answer — it tells me exactly what to fix.</p>
<p>One line back is plenty. I read every reply myself.</p>
<p>Amariah<br />I build Atlarix</p>
<p style="color:#475569;font-size:14px;">PS — on Windows, the Store build is the one to have: uninstall the copy you've got and reinstall from the link above. Your projects are folders on your disk, so they stay put.</p>
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
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
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
  recipients.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return recipients;
}

async function sendViaResend({ apiKey, from, replyTo, to, subject, text, html }) {
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
    process.env.NEXT_PUBLIC_SUPABASE_SECRET_KEY?.trim() || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
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
    sentLog.filter((e) => e.status === "sent").map((e) => e.email?.toLowerCase()),
  );

  const pending = FORCE
    ? recipients
    : recipients.filter((r) => !sentEmails.has(r.email));

  console.log(`Recipients after filters (excl. your 2 emails): ${recipients.length}`);
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
    console.warn(`Preferred From failed (${probeResult.error}); using EMAIL_SOURCE + reply_to`);
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
  console.log(`Probe OK (id=${probeResult.id})${useFallbackFrom ? " [fallback From]" : ""}`);

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

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}, Total targeted: ${pending.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
