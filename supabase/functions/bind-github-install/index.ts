import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAuthedUser, json, corsHeaders } from '../_shared/auth.ts';

/**
 * Bind a GitHub App installation to the signed-in Atlarix account.
 *
 * THE THREAT THIS EXISTS TO STOP. After an install, GitHub redirects the user to
 * our callback URL carrying `installation_id` — a small integer, on a plain GET
 * that anybody can construct. Nothing about receiving that number proves the
 * sender has anything to do with the installation. Without a real check, a
 * stranger visits `/reviewer/setup?installation_id=<guess>` and binds someone
 * else's repositories to their own account: they then see review history for
 * code they cannot otherwise read, and the rightful owner's bot stops working.
 * `installation_id` being the PRIMARY KEY reduces that to first-writer-wins,
 * which is a race, not a control.
 *
 * SO THE CHECK IS: exchange the OAuth `code` GitHub sent alongside it for a
 * user-to-server token, then ask GitHub which installations THAT USER can
 * administer (`GET /user/installations`) and require the target to be among
 * them. The code is single-use, short-lived, and only ever delivered to our
 * registered callback URL, which is what makes it evidence.
 *
 * WHY SUPABASE'S OWN GITHUB LOGIN CANNOT DO THIS JOB. It is a different OAuth
 * application — client id `Ov23…` versus this App's `Iv2…` — and
 * `GET /user/installations` only lists installations of the app that issued the
 * token. A Supabase GitHub session tells us who someone is on GitHub; it cannot
 * tell us what they may administer here.
 *
 * Two identities are being joined, and BOTH are verified independently: the
 * Atlarix account from the Supabase JWT, and the GitHub account from the code
 * exchange. Neither is taken from the request body.
 */

const GITHUB_CLIENT_ID = Deno.env.get('GITHUB_CLIENT_ID');
const GITHUB_CLIENT_SECRET = Deno.env.get('GITHUB_CLIENT_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('NEXT_PUBLIC_SUPABASE_SECRET_KEY');

type Installation = {
    id?: number;
    account?: { login?: string } | null;
    repository_selection?: string;
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
        console.error('[bind] GitHub OAuth is not configured');
        return json({ error: 'bind_not_configured' }, 500);
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.error('[bind] Supabase service credentials missing');
        return json({ error: 'server_misconfigured' }, 500);
    }

    // Identity 1: the Atlarix account. From the verified JWT, never the body.
    const user = await getAuthedUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);

    let code = '';
    let installationId = 0;
    try {
        const body = await req.json();
        code = typeof body?.code === 'string' ? body.code.trim() : '';
        installationId = Number(body?.installation_id);
    } catch {
        return json({ error: 'invalid_body' }, 400);
    }
    if (!code) return json({ error: 'missing_code' }, 400);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        return json({ error: 'missing_installation_id' }, 400);
    }

    // Identity 2: the GitHub account. Exchange the single-use code.
    let accessToken = '';
    try {
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code,
            }),
        });
        // GitHub answers 200 with an `error` field rather than a 4xx on a bad or
        // reused code, so the status alone is not the answer.
        const tokenJson = await tokenRes.json();
        if (tokenJson?.error || typeof tokenJson?.access_token !== 'string') {
            console.warn(`[bind] code exchange refused: ${tokenJson?.error ?? 'no token'}`);
            return json({ error: 'github_auth_failed' }, 400);
        }
        accessToken = tokenJson.access_token;
    } catch (e) {
        console.error('[bind] code exchange threw:', e);
        return json({ error: 'github_auth_failed' }, 502);
    }

    // THE CONTROL. Which installations may this GitHub user administer?
    let installation: Installation | undefined;
    try {
        // Paginated on purpose: someone with many installations must not fail to
        // find theirs because it sat on page two.
        for (let page = 1; page <= 5 && !installation; page++) {
            const res = await fetch(
                `https://api.github.com/user/installations?per_page=100&page=${page}`,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                    },
                },
            );
            if (!res.ok) {
                console.error(`[bind] /user/installations failed: ${res.status}`);
                return json({ error: 'github_lookup_failed' }, 502);
            }
            const payload = await res.json();
            const list: Installation[] = Array.isArray(payload?.installations)
                ? payload.installations
                : [];
            installation = list.find((i) => Number(i?.id) === installationId);
            if (list.length < 100) break;
        }
    } catch (e) {
        console.error('[bind] /user/installations threw:', e);
        return json({ error: 'github_lookup_failed' }, 502);
    }

    if (!installation) {
        // Distinct from a server error, and the distinction matters to the reader:
        // this is a definite answer about their permissions, not something to retry.
        console.warn(`[bind] user cannot administer installation ${installationId}`);
        return json({ error: 'installation_not_yours' }, 403);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data, error } = await supabase.rpc('bind_github_install_service', {
        p_user_id: user.id,
        p_installation_id: installationId,
        p_account_login: installation.account?.login ?? null,
        p_repository_selection: installation.repository_selection ?? null,
    });

    const row = data as { ok?: boolean; error?: string; rebound?: boolean } | null;
    if (error || row?.ok === false) {
        if (row?.error === 'installation_already_bound') {
            // Someone else already owns it. Say so plainly — silently reassigning
            // would move every future review's bill to whoever bound it last.
            return json({ error: 'installation_already_bound' }, 409);
        }
        console.error(`[bind] rpc failed: ${error?.message ?? row?.error}`);
        return json({ error: 'bind_failed' }, 500);
    }

    console.log(`[bind] installation ${installationId} -> ${user.id}`);
    return json({
        ok: true,
        installation_id: installationId,
        account_login: installation.account?.login ?? null,
        repository_selection: installation.repository_selection ?? null,
    });
});
