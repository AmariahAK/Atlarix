# Atlarix PR Bot — Agreed Design Spec

*Working reference. Captures what we decided across the planning conversation. Not final architecture — a starting contract to build from. Where a thing is deliberately deferred, it says so.*

*Rev 2 (Aug 2026): BYOK dropped — Atlarix Core is now the ONLY engine. Added the account/sign-in/payment flow, the out-of-credits behavior, the harness↔bot communication mechanism, and the no-force-coupling rule.*

---

## 1. What it is (one paragraph)

**Name:** handle in PR threads = **`@atlarixagent`** ("agent" over "bot" — on-brand, since Atlarix makes AI into a capable agent, and it carries continuity with the historical `atlarix-agent` OSS commit co-author). In-app / docs name = **"Atlarix Reviewer."** It's a *feature/surface of Atlarix*, not a standalone brand — literally "cursoragent-on-PRs." NOT "Bugbot" (that's Cursor's product). Verify handle + GitHub App display-name availability before committing.

A GitHub App that reviews pull requests. You tag it or it fires on PR events, it pulls the diff and surrounding context, runs it through Atlarix Core, and posts inline comments plus a summary — same category as CodeRabbit / Cursor Bugbot. It runs **standalone** (full review on its own) and gets **better** when the author's side is Atlarix (reader/judge split). It reads code and reasons; it does **not** execute or test code. It reviews and can **approve**, but never merges.

The strategic point, not just the feature: Atlarix today is a private, local-first workstation that stops at the edge of your machine. The moment code becomes a PR it becomes a *team* artifact, and Atlarix currently has no presence there. The bot is Atlarix extending onto the team/collaboration surface without betraying the local-first identity — local authoring, independent team-side review. That's the whole reason it's on-thesis rather than a random second product.

---

## 2. Hard scope decisions (locked)

| Decision | Ruling |
|---|---|
| **Does it execute/test code?** | **No.** Read, reason, comment. No sandbox running untrusted code. This kills the biggest cost line *and* the biggest security surface (the RCE class of attack) in one move. |
| **Does it merge?** | **Never.** No auto-merge, ever. |
| **Does it approve?** | **Yes, allowed.** It can act as an approving reviewer (auto-approve) *if the repo permits it*. If the repo doesn't allow it as a formal approver, it falls back to a plain "LGTM" comment. No merge either way. |
| **Reader/judge handoff** | **Designed in now as core**, not deferred. Build the handoff protocol from the start. (Solo review still has to work fully on its own — see §5.) |
| **Engine** | **Atlarix Core ONLY.** BYOK dropped (see §7). No user model keys stored, ever. |
| **Force app + bot together?** | **No.** Bot works fully standalone; the app is the upsell, never a tollgate (see §10). |
| **Platform** | **GitHub only for v1.** Not GitLab, not Bitbucket. (Rationale in §9.) |

---

## 3. The core loop

Standard for the category — the moat is review quality, not the plumbing.

1. **Event fires** — GitHub sends a webhook on `pull_request` (opened/updated), `pull_request_review_comment`, and `issue_comment` (the last catches `@atlarix` mentions).
2. **Authenticate as the install** — per-install token, fine-grained repo permissions.
3. **Resolve the account + credits** — look up which Atlarix account owns this installation (the bind from §10); check the shared credit wallet. If empty → post the out-of-credits nudge (§7) and stop.
4. **Gather context (live, no clone)** — pull the diff, changed files, file contents at the ref, linked issue, PR description via the GitHub API. Reading is done live off the API — no repo clone needed for reason-only review (see §6).
5. **Build the fixed context structure** — the format-first idea: pin down *base repo + linked issue (if any) + diff + change rationale* into a bounded, structured payload before the model sees it. Bounded structured context = focused review + controlled token cost.
6. **Review** — run through Atlarix Core (reader/judge if Atlarix is the author, solo otherwise).
7. **Post back** — inline comments + summary. Approve / LGTM per §2.
8. **Log** — write the result to Supabase (history, credit accounting, per-repo usage visibility).

---

## 4. Hosting — reuse what already exists

No new infrastructure. The bot is "the Atlarix proxy, triggered by a GitHub event instead of an app request."

- **Railway** = the always-on side. Webhook endpoint + orchestration + running Atlarix Core. The thing that's awake and doing work.
- **Supabase** = state. One project (NOT a second one — see §10). Installs (`github_installs`), per-repo config, review history, credits, accounts.

Flow: GitHub → Railway endpoint → Railway resolves install→account + checks credits (Supabase) → runs review (Atlarix Core on Railway) → posts to GitHub → logs result (Supabase).

**Non-negotiable boundary:** even though there's no code-execution sandbox, treat the review pipeline as untrusted-input handling. Railway holds Supabase keys and model credentials; the thing handling strangers' diffs must not be able to spill those credentials into output. (Cutting the sandbox makes this lighter than it would've been — but the instinct stays.)

---

## 5. Reader / judge architecture (core)

This is the differentiator no competitor can copy, because no competitor has both the private local workstation *and* the reviewer. (Cursor has Bugbot but its workstation is a cloud editor, not a private local-first one; CodeRabbit has no workstation at all.)

- **When the author is Atlarix:** the local workstation authored the code and knows what it intended, what changed, why, and what it verified. It hands the bot a **structured context payload** — here's what changed, why, what was checked. The bot is the **independent judge**: it *verifies and probes the gaps*, it does not re-derive everything from the diff. Faster, cheaper, higher-signal.
- **When the author is not Atlarix (no payload):** the bot does the **full cold review on its own.** This is the fallback and it must be first-class — the whole addressable market is people who don't run Atlarix.

**The rule that keeps it honest:** the handoff is *evidence the judge checks*, never a verdict the judge rubber-stamps. If the bot just trusts Atlarix's "I tested this, it's fine," you've defeated the entire reason to have a separate reviewer — the author would be grading its own homework. Genuine independence even when it's your own model on both ends. Mirrors how good review works (reviewer perspective must differ from generator perspective) and how CodeRabbit runs a separate judge model internally before posting.

### How the two halves actually communicate (no direct wiring)
Two channels, both already shared — you do NOT build a custom socket between the IDE and the bot server:
1. **The PR as mailbox.** The workstation writes its context payload into the PR body (or a structured marker / linked comment). The bot, firing on the webhook, reads it and switches cold-review → judge mode. GitHub is the message bus.
2. **The shared account as identity link.** Both products authenticate against the same account, so each side recognizes the other. GitHub tells you install status directly — `GET /repos/{owner}/{repo}/installation` (plus `/users/{username}/installation` and `/orgs/{org}/installation`) — that's your "connected" signal.

**Build order within this:** solo cold review first → then wire the handoff as an *optional protocol* on top (payload present → judge; absent → cold). Design the hooks in from the start; don't hard-couple the two products. **V1 = one-way handoff** (workstation writes → bot reads → judges). Full bidirectional IDE↔bot chat is v2 polish — don't balloon v1.

---

## 6. Reading strategy — live, not cloned

- **Reason-only review** (the default, most PRs): work **live off the GitHub API** — diff, changed files, file contents at a ref, linked issues. **No clone.** Fast, cheap, no checkout. This is what GitHub's own review AI and the lightweight reviewers do.
- **Deliberately out of scope:** anything requiring a checkout to disk to *run* the code. Since we cut execution (§2), we don't need clones at all for v1. If execution ever comes back: push test execution into the PR's *own* GitHub Actions runner (runs on the user's Actions quota, in an environment already isolated from your backend) rather than cloning onto Railway. **Not v1. Recorded so the door isn't lost.**

---

## 7. The engine and the money side of it

### Atlarix Core is the ONLY engine
Core = Amariah's own managed models (DeepSeek / GLM), billed to the user's shared credit wallet. This is exactly Cursor Bugbot's model: Bugbot runs on Cursor's own frontier + in-house models, the user pays Cursor, and **no user model keys are ever stored.** Same here. Inference is your cost, funded by the user's prepaid credits (PAYG, metered) — no subsidy, no loss-leader exposure. The bot debits the **same credit meter** the app uses (one credit system in Supabase, two products spending from it).

### BYOK — DROPPED (and why)
The bot fires on a webhook **when the user isn't present**, so any BYOK key would still have to live on your server at review time to work. That means storing users' live model credentials — a real liability — for no upside, since Core already covers the inference. Cursor Bugbot deliberately avoids holding user model keys for exactly this reason. So BYOK is off the table for the bot. (It remains a thing in the *app*, where the user is present and running locally — but not here.)

### Free/promotional open-weight models — optional cost tier, never the backbone
Real but unstable — the free model's bill is waived *at the provider* (a lab trades free compute for reach + training data), capped by rate limits. You'd tap it by routing through OpenRouter's free tier + direct provider free tiers. **Never build the bot's core on this** — free models rotate and vary in quality, and review quality *is* the product. At most an optional cheap lane; Core is the spine.

### Out-of-credits behavior (decide now, because Core is the only engine)
With no BYOK fallback, an empty wallet = a dead bot. Don't let that look broken. When a PR fires and the account has no credits, the bot posts **one** short comment ("Atlarix is connected but out of credits — top up at atlarix.dev to enable reviews") instead of silently doing nothing. One-time per PR, not spam. Turns an empty wallet into a conversion prompt.

---

## 8. Pricing (structure + ballparks — treat numbers as starting knobs)

**Margin note:** don't ship a tier where the monthly fee is fully consumed by bundled inference credits. CodeRabbit can bundle because it's funded buying market share. If you bundle Core credits, the price must be **base + credits**, not **base including credits** — otherwise platform revenue is ~$0 and you're working for free.

### Recommended spine — Shape A (structurally safe)
- **Bot base fee:** ~$10–15/month. Covers the *platform* (the App, orchestration, pipeline, state). Independent of usage.
- **Atlarix Core:** billed **separately** on top — PAYG credits, same shared wallet as the app. You meter inference; the base fee is clean margin.
- **OSS / public repos:** free *as a product* (no base fee) **but Core credits still required** for the inference — you do NOT eat OSS-volume inference on your own account. Optionally a tiny, hard-capped free-credit trial purely as a funnel, ceiling set to what you can afford.
- **Private repos:** base fee applies; Core metered on top.

### Optional bundle — Shape B (only if the math is base-plus-credits)
A CodeRabbit-style "one price" tier: e.g. **$20 base + $20 of Core credits included, priced ~$35–40/mo** — *not* "$20 total split into bot + $20 credits." Bundle for convenience, never give the whole fee back as inference. (Undecided whether to offer this at all.)

### Approve/LGTM
No separate charge. Auto-merge is off the table entirely and only approve/LGTM remains, so there's no risky privileged action to gate. Included.

### Guardrail to build from day one
A busy repo can open a *lot* of PRs. Meter **per-repo consumption** from the start (even if you don't act on it yet) so one whale repo reviewing 300 PRs/month can't quietly torch your margin. Credit-based billing or a per-repo PR cap protects you.

---

## 9. Platform scope & why GitHub-only

- **GitHub is "complete enough."** Git is ~universal as a protocol; the competition is at the hosting layer, and GitHub dominates it — and it's the only platform where your public-review self-marketing works, because it's where the developers (and your existing OSS footprint) are.
- **Bitbucket: skip outright.** Sunsetting (Data Center new-license sales ended 2026, full EOL 2029). Building for a platform on a countdown is wasted effort.
- **GitLab: fast-follow only when a paying customer needs it.** Not for "looking complete."
- **On-thesis expansion, if any: the self-hosted forges (Gitea / Forgejo / Codeberg)** — people self-host for *data sovereignty and anti-AI-training* reasons, which is *exactly* Atlarix's privacy buyer. Sharper fit than chasing Bitbucket's enterprises. **Later, not now.**

---

## 10. Account model, sign-in & payment flow

The thing that makes "app-only / bot-only / both" resolve cleanly — and where the atlarix.dev page earns its place.

### One account = the hub
- The Core credit **wallet** is a property of the **account**, not of either product. Credits are **shared** across app and bot (one wallet) — fewer complaints, and it *is* the natural bundle discount (a "both" user's credits stretch across both).
- Both products read the same account. Bot-only user has an account with a linked install and no app usage; app-only user has an account with no install; "both" is one account with both populated.
- **"Connected" = a `github_installs` row on the account** — not a link between two databases.

### ONE Supabase, not two
A second Supabase project would mean two accounts / two wallets per "both" user and a fragile cross-DB sync — which is the manual connection we rejected, and it kills shared credits. Add **bot tables to the existing project** (`github_installs`, per-repo config, review history). Reuse the existing users table, auth, and wallet wholesale.

### The install → sign-in → bind → fund flow (this is the answer to "how do they sign in and pay")
Installing the GitHub App and having an account are **two separate systems**; the atlarix.dev page is the bridge that joins them (identical pattern to how Cursor connects a GitHub org through its dashboard):
1. **User installs the GitHub App** (Marketplace or link), picks repos. GitHub now has an `installation` with an ID — but your backend doesn't know who they are yet.
2. **GitHub redirects to your Setup URL** (configured in the App settings), carrying the `installation_id`. They land on an atlarix.dev "connect your install" page.
3. **They sign in / sign up on atlarix.dev** — same Supabase auth the app uses. New bot-only users create the account right here; existing Atlarix users just log in.
4. **Bind the install to the account** — now authenticated *and* holding the `installation_id`, write the `github_installs` row. That's `connected = true`. This is the one genuinely new bit of logic to build.
5. **They fund the shared wallet** — same top-up flow the app already has ($10 top-up, etc.). If they already have credits from the app, they're already funded.

### What's actually new vs reused
- **New:** the setup/redirect page that catches `installation_id`, the `github_installs` table, the bind logic (step 4), the out-of-credits nudge.
- **Reused wholesale:** Supabase auth, the credit wallet, payment integration, top-up flow. No new payment system.

### Do NOT force app + bot together
Cursor Bugbot is a standalone GitHub integration — it does **not** require installing the Cursor editor (5-min install, connect repo, done). Forcing an Atlarix-app install in front of the bot would wall off the bot's widest funnel (people who'd try a review bot are mostly not ready to adopt a new local IDE the same day). The bot works standalone; the app is the **upsell** (reader/judge combo), never a gate. Also do NOT build "BYOK-via-the-app" — it just relocates the key-storage problem to the server *and* adds the forced-install wall.

---

## 11. Per-repo config

- A **`.atlarix.yaml`** in the repo for per-project tuning — review depth, paths to ignore, severity thresholds, whether approve-as-reviewer is allowed. Table stakes for the category. It's also where the "am I allowed to formally approve" flag lives (§2). (Exact schema undecided.)

---

## 12. Distribution — the part that is NOT "list and wait"

- **The Marketplace is a storefront, not a marketing channel.** Listing makes you *findable by someone already searching*; it does not generate demand. It's the checkout counter, not the foot traffic.
- **The demand engine is the public reviews themselves.** Every good review on a public PR puts the handle in the thread where target developers watch — the *same* engine as the existing OSS distribution thesis; the bot's public reviews *are* Atlarix name-recognition in front of maintainers.
- **You are the first user — this solves the chicken-and-egg.** You already run an OSS PR strategy on named repos:
  1. **Dogfood on your own private repos** (Atlarix, Tabibu, etc.) until the review quality is something *you'd* keep installed.
  2. **Attach it to the public PRs you're already making** — the bot reviews *your own* contribution in public, no maintainer install required, handle visible in the thread.
  3. **Then the social shoutout**, pointing at a real footprint ("here are 40 real reviews on [recognizable repos]") — not an empty product.
- **Two cautions:** (a) the quality bar is *higher* in public — a bad review on a big repo is a negative ad; dogfood private until sharp. (b) Only review your *own* repos and your *own* contributions; auto-reviewing strangers' PRs uninvited = spam/blocks.
- **Marketplace paid-listing has hoops** (verification, sometimes an install threshold). Sequence: **list free → build installs + public-review footprint → clear requirements → add paid plan.**

### Waitlist + build-in-public (start now, at the front of the build)
- **Build-in-public is the demand tap; the waitlist is the bucket.** Document the build raw (phone clips, screenshots, "here's what broke today") — NOT harness-series-level production. Opportunistic milestone posts, not a calendar quota; ~1–3/week driven by real milestones, floor ~1/week, ceiling ~daily. Different job and far lighter effort than the harness series — keep it as exhaust from work you're doing anyway. The paper-scribble "day 1, here's why I'm building this" post is the ideal opener.
- **Buy the waitlist, don't build it.** Collecting an email is the easy 10%; spam filtering, validation, double-opt-in, launch-day broadcast are the other 90% and don't build the product. Use a tool now so the bucket exists today while the product is months out. Candidates: **Waitlister** (free tier + API + official MCP server for Claude/Cursor — on-brand, manageable from code) or **LaunchList** (free hosted page in 5 min, 100 signups free, one-time paid tiers). **Avoid GetWaitlist** (free tier closed to new accounts since mid-2025). Waitlist size is launch fuel, not a success metric — measure installs + kept-installed after launch.
- **The stated reason** (for the build-in-public story — a *why* strangers nod at, not "because I can"): *Atlarix stops at your machine; the moment code becomes a PR nothing carries your local AI's understanding into the team review — every other bot starts cold. Mine doesn't, because it's connected to the harness that wrote the code.* Keep the reason anchored on **completing Atlarix + feeding distribution**, NOT on "beating CodeRabbit" — if the justification drifts to "the PR-bot market is huge," that's the drift to watch.

---

## 13. Review quality — the actual product (said plainly)

Everything above gets you a bot that *comments*. Getting one that comments *well* — sharp, low-noise, worth keeping installed — is the whole product and the bulk of the work. Teams uninstall reviewers that nitpick. Budget the real effort here:

- A **judge/verifier pass** before anything posts, to filter false positives (keeps it from crying wolf).
- **Context-selection logic** — what to feed the model beyond the raw diff (the cross-file reach is where real bugs hide and naive reviewers miss).
- **Model eval on your own review task** before betting the product on any given open-weight model — don't trust benchmark blogs; a reviewer that misses real bugs or nitpicks gets uninstalled fast.

The plumbing is a couple of weekends. This is the couple of *months*. Don't let the fast start set expectations for the whole.

---

## 14. Rough timeline (focused-hours, solo)

- **~1 week:** bot leaves its first comment on a PR (exciting, not shippable).
- **~3–4 weeks:** standalone bot works end-to-end, dogfooding on your own private repos, Core + account/payment wired.
- **~2–3 months:** review quality good enough to defend on a public thread — ready to seed on your OSS PRs and do the shoutout.
- **After that:** paid private tier once there's traction; reader/judge polish; (much later) forge expansion.

**Caveats on record:** split against Deriv onboarding (~Oct 5 start), SPACInsider, Tabibu, the harness series — wall-clock will run longer than effort-hours suggest. The "fast start" is the trap; hold scope (sandboxing already cut — keep that line; BYOK already cut — keep that too). Every "oh and it could also…" resets the clock.

---

## 15. Build order

1. **GitHub App skeleton** — register the App, webhook → Railway, pull diff/context via API, run through Atlarix Core, post one comment back. The 1-week "it visibly reviews a PR" milestone.
2. **Account linking + payment on atlarix.dev** — the install→sign-in→bind→fund flow (§10), `github_installs` table, out-of-credits nudge. Load-bearing; everything hangs off it. (No key storage to build — Core-only.)
3. **Solo cold review, made good** — the review-quality work (§13). The real product.
4. **`.atlarix.yaml` config + approve/LGTM logic.**
5. **Reader/judge handoff protocol** — the optional Atlarix-author path, wired on top of working solo review (one-way for v1).
6. **Free Marketplace listing + dogfood → public-PR seeding** (§12). Waitlist + build-in-public run in parallel from day one.
7. **Paid private tier + per-repo metering guardrail** once traction shows.

---

*Open items still genuinely undecided (not blockers): exact base-fee number; whether to offer the Shape-B bundle at all; whether the free-model cheap lane ships at launch or later; the precise `.atlarix.yaml` schema; which waitlist tool (Waitlister vs LaunchList).*
