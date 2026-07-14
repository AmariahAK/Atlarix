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
const LOG_FILE = join(ROOT, "scripts", ".outreach-sent.log.json");

const EXCLUDED_EMAILS = new Set(
  ["amariah.abish@gmail.com", "amani.kamau06@gmail.com"].map((e) => e.toLowerCase()),
);

const SUBJECT = "Quick question about how you use Atlarix";
const PREFERRED_FROM = "Amariah <amariah@atlarix.dev>";
const DEFAULT_REPLY_TO = "amariah@atlarix.dev";
const THROTTLE_MS = 600;

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

function deriveFirstName(user) {
  const meta = user.user_metadata || {};
  if (typeof meta.first_name === "string" && meta.first_name.trim()) {
    return meta.first_name.trim();
  }
  if (typeof meta.full_name === "string" && meta.full_name.trim()) {
    return meta.full_name.trim().split(/\s+/)[0];
  }
  if (typeof meta.name === "string" && meta.name.trim()) {
    return meta.name.trim().split(/\s+/)[0];
  }
  const email = user.email || "";
  const local = email.split("@")[0] || "";
  if (local) {
    const part = local.split(/[._+-]/)[0];
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }
  return "there";
}

function buildBodies(firstName) {
  const text = `Hi ${firstName},

One question — are you using Atlarix on client work or just personal projects?

Trying to understand who actually finds it useful before I build anything new.

Amariah

You can reply to this email, or write to amariah@atlarix.dev.`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.5;color:#0f172a;">
<p>Hi ${escapeHtml(firstName)},</p>
<p>One question — are you using Atlarix on client work or just personal projects?</p>
<p>Trying to understand who actually finds it useful before I build anything new.</p>
<p>Amariah</p>
<p style="color:#64748b;font-size:14px;">You can reply to this email, or write to <a href="mailto:amariah@atlarix.dev">amariah@atlarix.dev</a>.</p>
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
    if (EXCLUDED_EMAILS.has(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);

    recipients.push({
      email,
      firstName: deriveFirstName(user),
      userId: user.id,
    });
  }

  recipients.sort((a, b) => a.email.localeCompare(b.email));
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

  if (recipients.length !== 53 && !ONLY_EMAIL && LIMIT == null) {
    console.warn(
      `WARNING: expected 53 recipients; got ${recipients.length}. Review list before bulk send.`,
    );
  }

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
  if (sent !== 53 && !ONLY_EMAIL && LIMIT == null) {
    console.warn(`Expected 53 successful sends; got ${sent}. Check failures and log.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
