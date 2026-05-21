#!/usr/bin/env node
/**
 * v8.5.0 upgrade outreach — confirmed Supabase users via Resend.
 * Replies go to amariah@atlarix.dev.
 *
 * Usage (from Atlarix/):
 *   npm run email:v85-upgrade:dry-run
 *   npm run email:v85-upgrade -- --only you@example.com
 *   npm run email:v85-upgrade
 *   node scripts/send-v85-upgrade-emails.mjs --init-ledger-from-supabase
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER = join(SCRIPT_DIR, ".feedback-outreach-v85-sent.jsonl");
const LEDGER_PATH = process.env.OUTREACH_LEDGER_PATH || DEFAULT_LEDGER;
const CAMPAIGN_ID = "v85-upgrade-outreach";
const VERSION_LABEL = "8.5.0";

const SKIP_EMAILS = new Set([
  "amariah.abish@gmail.com",
  "amani.kamau06@gmail.com",
]);

const FROM_EMAIL = process.env.EMAIL_SOURCE?.trim() || "amariah@atlarix.dev";
const REPLY_TO = process.env.OUTREACH_REPLY_TO?.trim() || "amariah@atlarix.dev";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const INCLUDE_UNCONFIRMED = args.has("--include-unconfirmed");
const onlyIdx = process.argv.indexOf("--only");
const ONLY_EMAIL =
  onlyIdx >= 0 ? process.argv[onlyIdx + 1]?.trim().toLowerCase() : null;

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

loadEnv();

const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const resendKey = requireEnv("RESEND_API_KEY");

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function loadSentEmails() {
  const set = new Set();
  if (!existsSync(LEDGER_PATH)) return set;
  for (const line of readFileSync(LEDGER_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row.email && typeof row.email === "string") {
        set.add(row.email.toLowerCase());
      }
    } catch {
      /* skip */
    }
  }
  return set;
}

function appendLedgerEntry({ email, resendId }) {
  appendFileSync(
    LEDGER_PATH,
    `${JSON.stringify({
      campaign: CAMPAIGN_ID,
      email: email.toLowerCase(),
      at: new Date().toISOString(),
      resendId: resendId ?? null,
    })}\n`,
    "utf8",
  );
}

async function fetchAllUsers() {
  const all = [];
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw new Error(`Supabase error: ${error.message}`);
    const batch = data?.users ?? [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

function deriveFirstName(email) {
  const namePart = email.split("@")[0].split(/[._-]/)[0];
  if (!namePart) return "there";
  return namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase();
}

function buildEmail(email) {
  const firstName = deriveFirstName(email);
  const subject = `Atlarix v${VERSION_LABEL} is available`;

  const html = `
<p>Hey ${firstName},</p>

<p>Amariah here — founder of Atlarix.</p>

<p>
  We have a new version of Atlarix — <strong>v${VERSION_LABEL}</strong>. To get the latest build,
  install it from <a href="https://atlarix.dev">atlarix.dev</a>.
</p>

<p>
  If you have feedback or run into anything odd, just reply to this email — I read every message.
</p>

<p>
  Thanks for using Atlarix.
</p>

<p>
  — Amariah<br/>
  Founder, Atlarix / NorahLabs<br/>
  Nairobi, Kenya
</p>

<p style="color:#888;font-size:12px;">
  You're receiving this because you signed up for Atlarix.
  This is a one-time outreach, not a newsletter.
</p>
  `.trim();

  const text = `
Hey ${firstName},

Amariah here — founder of Atlarix.

We have a new version of Atlarix — v${VERSION_LABEL}. To get the latest build, install it from atlarix.dev:

https://atlarix.dev

If you have feedback or run into anything odd, just reply to this email — I read every message.

Thanks for using Atlarix.

— Amariah
Founder, Atlarix / NorahLabs
Nairobi, Kenya

---
You're receiving this because you signed up for Atlarix.
This is a one-time outreach, not a newsletter.
  `.trim();

  return { subject, html, text };
}

function filterEligible(users, alreadySent) {
  return users.filter((u) => {
    if (!u.email) return false;
    const lower = u.email.toLowerCase();
    if (SKIP_EMAILS.has(lower)) return false;
    if (alreadySent.has(lower)) return false;
    if (!INCLUDE_UNCONFIRMED && !u.email_confirmed_at) return false;
    if (ONLY_EMAIL && lower !== ONLY_EMAIL) return false;
    return true;
  });
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Amariah @ Atlarix <${FROM_EMAIL}>`,
      to: [to],
      reply_to: REPLY_TO,
      subject,
      text,
      html,
      tags: [
        { name: "campaign", value: CAMPAIGN_ID },
        { name: "type", value: "upgrade-outreach" },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || String(res.status));
  }
  return data.id;
}

async function initLedgerFromSupabase() {
  console.log("Initializing ledger from Supabase (no emails will be sent)...");
  console.log(`Ledger file: ${LEDGER_PATH}\n`);
  const users = await fetchAllUsers();
  const already = loadSentEmails();
  let added = 0;
  for (const u of users) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    if (SKIP_EMAILS.has(lower)) continue;
    if (!INCLUDE_UNCONFIRMED && !u.email_confirmed_at) continue;
    if (already.has(lower)) continue;
    appendLedgerEntry({ email: lower, resendId: "seeded-from-supabase" });
    already.add(lower);
    added++;
  }
  console.log(`Recorded ${added} addresses as already contacted.`);
  console.log(`Total in ledger: ${already.size}`);
}

async function main() {
  if (process.argv.includes("--init-ledger-from-supabase")) {
    await initLedgerFromSupabase();
    return;
  }

  const alreadySent = loadSentEmails();
  console.log(`Ledger: ${LEDGER_PATH} (${alreadySent.size} already recorded)\n`);

  console.log("Fetching users from Supabase...");
  const users = await fetchAllUsers();
  const eligible = filterEligible(users, alreadySent);

  const skippedLedger = users.filter(
    (u) =>
      u.email &&
      !SKIP_EMAILS.has(u.email.toLowerCase()) &&
      alreadySent.has(u.email.toLowerCase()),
  );

  console.log(`Total users: ${users.length}`);
  console.log(`Skipping: ${SKIP_EMAILS.size} internal accounts`);
  console.log(`Skipping (already in ledger): ${skippedLedger.length}`);
  console.log(`Would send to: ${eligible.length} users\n`);

  if (DRY_RUN) {
    console.log("--- DRY RUN (no emails sent) ---\n");
    for (const u of eligible.slice(0, 10)) {
      console.log(`  ${u.email}`);
    }
    if (eligible.length > 10) {
      console.log(`  ... and ${eligible.length - 10} more`);
    }
    return;
  }

  const results = { sent: [], failed: [] };

  for (const user of eligible) {
    const email = user.email;
    const { subject, html, text } = buildEmail(email);

    try {
      const id = await sendViaResend({ to: email, subject, text, html });
      appendLedgerEntry({ email, resendId: id });
      console.log(`✅ Sent to ${email} (id: ${id})`);
      results.sent.push(email);
    } catch (err) {
      console.error(`❌ Failed for ${email}: ${err.message}`);
      results.failed.push({ email, error: err.message });
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n── Summary ──────────────────────────────");
  console.log(`Sent:   ${results.sent.length}`);
  console.log(`Failed: ${results.failed.length}`);
  if (results.failed.length > 0) {
    console.log("\nFailed addresses:");
    results.failed.forEach((f) => console.log(`  ${f.email} — ${f.error}`));
  }
  console.log("\nDone. Replies go to", REPLY_TO);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
