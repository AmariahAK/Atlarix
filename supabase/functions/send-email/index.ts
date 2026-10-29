// DISABLED 2026-10-29 after the overnight attack (one account sent 28 emails to
// addresses it chose, with its own subject and body: an open relay). Nothing in
// the app, the website or the reviewer calls this function any more
// (src/lib/email/resend.ts is dead code), so it is switched off rather than
// fixed. This file IS what is deployed (version 49): keep it this way, or the
// next `supabase functions deploy` reopens the relay. If transactional email
// comes back, the server picks the recipient (the signed-in user) and a fixed
// template, never the client.
Deno.serve(() =>
  new Response(JSON.stringify({ ok: false, error: "send_email_disabled" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  }),
);
