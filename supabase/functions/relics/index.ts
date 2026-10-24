/**
 * Relics: publish, list, share, delete and view the pages the agent makes.
 *
 * THREATS, and the answer to each:
 * - Someone else's relic: every action but `view` acts on the caller's own rows
 *   (user id from the VERIFIED JWT, never the body). `view` gives a token only
 *   to the owner, or to anyone when the owner shared it by link.
 * - A relic attacking atlarix.dev: files are served by relics.atlarix.dev — a
 *   different site, no cookies, a strict CSP — inside `sandbox="allow-scripts"`
 *   frames (an opaque origin). This function never serves relic bytes.
 * - Free hosting on our bill: publishing requires paid Core (Pro, or credit
 *   above zero), the same rule the app applies before it calls here; caps per
 *   relic and per user (_shared/relic-files.ts).
 *
 * verify_jwt is false (config.toml): `view` of a shared relic is anonymous.
 * Every other action checks the JWT itself (getAuthedUser).
 *
 * - A cloud run's pages: the run has no user JWT, so the cloud service (the
 *   reviewer) publishes FOR the job's owner with RELICS_SERVICE_SECRET and
 *   `on_behalf_of`. That caller may only `publish` a NEW relic, shared by link
 *   (the Slack card links it); the paid rule still applies to the owner.
 *
 * Secrets: SUPABASE_URL, NEXT_PUBLIC_SUPABASE_SECRET_KEY, R2_ACCOUNT_ID,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default atlarix-relics),
 * RELICS_VIEW_SECRET (shared with the Worker), RELICS_SERVICE_SECRET (shared
 * with the reviewer; unset = no service publishing).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";
import { corsHeaders, getAuthedUser, json } from "../_shared/auth.ts";
import { RELIC_LIMITS, newRelicId, prepareRelicFiles } from "../_shared/relic-files.ts";
import { signRelicToken } from "../_shared/relic-token.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("NEXT_PUBLIC_SUPABASE_SECRET_KEY")!;
const VIEW_SECRET = Deno.env.get("RELICS_VIEW_SECRET") ?? "";
const SERVICE_SECRET = Deno.env.get("RELICS_SERVICE_SECRET") ?? "";
const BUCKET = Deno.env.get("R2_BUCKET") ?? "atlarix-relics";
const R2_ENDPOINT = `https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${BUCKET}`;
const VIEWER = "https://atlarix.dev/r/";
const FILES = "https://relics.atlarix.dev";

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const r2 = new AwsClient({
  accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") ?? "",
  secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "",
  service: "s3",
  region: "auto",
});

async function r2Put(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
  const res = await r2.fetch(`${R2_ENDPOINT}/${key}`, {
    method: "PUT",
    body: body as BodyInit,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`storage write failed (${res.status})`);
}

async function r2DeletePrefix(prefix: string): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    const list = await r2.fetch(`${R2_ENDPOINT}?list-type=2&prefix=${encodeURIComponent(prefix)}`);
    const keys = [...(await list.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
    if (!keys.length) return;
    await Promise.all(keys.map((k) => r2.fetch(`${R2_ENDPOINT}/${encodeURI(k)}`, { method: "DELETE" })));
  }
}

/** Paid Core: Pro, or a spendable balance above zero. */
async function isPaid(userId: string): Promise<boolean> {
  const { data: plan } = await db.from("users").select("plan, effective_tier").eq("id", userId).maybeSingle();
  const row = plan as { plan?: string; effective_tier?: string } | null;
  if (row?.plan === "pro" || row?.effective_tier === "pro") return true;
  const { data } = await db.rpc("get_credit_balance_service", { p_user_id: userId });
  const cents = Number((data as { balance_cents?: number } | null)?.balance_cents ?? 0);
  return cents > 0;
}

/** Constant-time string compare. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cloud service publishing a NEW relic for a job's owner; null for everyone else. */
function serviceCaller(req: Request, body: Body): { id: string; email: null } | null {
  if (SERVICE_SECRET.length < 32 || body.action !== "publish" || body.id) return null;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer || !sameSecret(bearer, SERVICE_SECRET)) return null;
  const owner = String(body.on_behalf_of ?? "");
  return UUID_RE.test(owner) ? { id: owner, email: null } : null;
}

type Body = {
  on_behalf_of?: string;
  action?: string;
  id?: string;
  title?: string;
  kind?: string;
  files?: unknown;
  visibility?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const service = serviceCaller(req, body);
  const user = service ?? (await getAuthedUser(req));

  try {
    if (body.action === "view") {
      if (!body.id) return json({ error: "Which relic?" }, 400);
      const { data: relic } = await db
        .from("relics")
        .select("id, user_id, title, kind, visibility, current_version")
        .eq("id", body.id)
        .maybeSingle();
      if (!relic) return json({ error: "Not found" }, 404);
      const owner = user?.id === relic.user_id;
      if (!owner && relic.visibility !== "link") {
        return json({ error: "This relic is private." }, user ? 403 : 401);
      }
      const token = await signRelicToken(VIEW_SECRET, relic.id);
      return json({
        id: relic.id,
        title: relic.title,
        kind: relic.kind,
        visibility: relic.visibility,
        version: relic.current_version,
        owner,
        src: `${FILES}/v/${token}/index.html`,
        status: `${FILES}/s/${token}`,
      });
    }

    if (!user) return json({ error: "Sign in to Atlarix first." }, 401);

    if (body.action === "list") {
      const { data } = await db
        .from("relics")
        .select("id, title, kind, visibility, current_version, bytes, updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(RELIC_LIMITS.maxRelicsPerUser);
      return json({ relics: (data ?? []).map((r) => ({ ...r, url: VIEWER + r.id })) });
    }

    if (body.action === "set-visibility") {
      if (!body.id || (body.visibility !== "private" && body.visibility !== "link")) {
        return json({ error: "Bad request" }, 400);
      }
      const { data } = await db
        .from("relics")
        .update({ visibility: body.visibility, updated_at: new Date().toISOString() })
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select("id")
        .maybeSingle();
      return data ? json({ ok: true, visibility: body.visibility }) : json({ error: "Not found" }, 404);
    }

    if (body.action === "delete") {
      if (!body.id) return json({ error: "Which relic?" }, 400);
      const { data } = await db
        .from("relics")
        .delete()
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select("id")
        .maybeSingle();
      if (!data) return json({ error: "Not found" }, 404);
      await r2DeletePrefix(`r/${body.id}/`);
      return json({ ok: true });
    }

    if (body.action === "publish") {
      if (!(await isPaid(user.id))) {
        return json(
          {
            error: "Hosted relics come with paid Atlarix Core (Pro or credit). This one was not published.",
            code: "not_paid",
          },
          402,
        );
      }
      const title = String(body.title ?? "").trim().slice(0, RELIC_LIMITS.maxTitle);
      if (!title) return json({ error: "A relic needs a title." }, 400);
      const kind = body.kind === "design" ? "design" : "page";
      const prepared = prepareRelicFiles(body.files);
      if ("error" in prepared) return json({ error: prepared.error }, 400);

      let id = body.id;
      let version = 1;
      if (id) {
        const { data: existing } = await db
          .from("relics")
          .select("current_version")
          .eq("id", id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!existing) return json({ error: "Not found" }, 404);
        version = existing.current_version + 1;
      } else {
        const { count } = await db
          .from("relics")
          .select("id", { count: "exact", head: true })
          .eq("user_id", user.id);
        if ((count ?? 0) >= RELIC_LIMITS.maxRelicsPerUser) {
          return json(
            { error: `You have ${RELIC_LIMITS.maxRelicsPerUser} relics already; delete some first (/relics).` },
            409,
          );
        }
        id = newRelicId();
      }

      // Files first, the pointer last: a viewer never sees a half-written version.
      for (const f of prepared.files) {
        await r2Put(`r/${id}/v${version}/${f.path}`, f.bytes, f.contentType);
      }
      await r2Put(`r/${id}/current.json`, JSON.stringify({ version }), "application/json");

      if (version === 1) {
        const { error } = await db.from("relics").insert({
          id,
          user_id: user.id,
          title,
          kind,
          current_version: 1,
          bytes: prepared.bytes,
          // A cloud run's page is linked from Slack: shared by its unguessable link.
          ...(service ? { visibility: "link" } : {}),
        });
        if (error) throw new Error(error.message);
      } else {
        const { error } = await db
          .from("relics")
          .update({
            title,
            kind,
            current_version: version,
            bytes: prepared.bytes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .eq("user_id", user.id);
        if (error) throw new Error(error.message);
      }
      await db.from("relic_versions").insert({
        relic_id: id,
        version,
        bytes: prepared.bytes,
        files: prepared.files.length,
      });
      return json({ id, url: VIEWER + id, version });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("relics:", e);
    return json({ error: "Something went wrong with the relic. Try again." }, 500);
  }
});
