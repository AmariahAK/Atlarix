import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Sends a transactional email via Resend server-side (A3). RESEND_API_KEY and the
// sender (EMAIL_SOURCE) live only here. The caller must be authenticated; the
// email body/subject are built client-side (not secret), but the API key and the
// verified sender never leave the server. Recipients are capped to limit abuse.

const MAX_RECIPIENTS = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_SOURCE");
  if (!apiKey || !from) return json({ error: "email_not_configured" }, 500);

  let to: string[] = [];
  let subject = "";
  let html = "";
  try {
    const body = await req.json();
    to = Array.isArray(body?.to) ? body.to.filter((x: unknown) => typeof x === "string") : [];
    subject = typeof body?.subject === "string" ? body.subject : "";
    html = typeof body?.html === "string" ? body.html : "";
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  if (to.length === 0 || to.length > MAX_RECIPIENTS || !subject || !html) {
    return json({ error: "invalid_email_request" }, 400);
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const data = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) {
      console.error("[send-email] Resend failed:", res.status, data);
      return json({ ok: false, error: data.message || String(res.status) }, 502);
    }
    return json({ ok: true, id: data.id });
  } catch (e) {
    console.error("[send-email] exception:", e);
    return json({ ok: false, error: "send_failed" }, 502);
  }
});
