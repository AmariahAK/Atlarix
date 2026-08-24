# Atlarix PR Bot — Agreed Design Spec

*Working reference. Captures what we decided across the planning conversation. Not final architecture — a starting contract to build from. Where a thing is deliberately deferred, it says so.*

---

## 1. What it is (one paragraph)

A GitHub App that reviews pull requests. You tag it or it fires on PR events, it pulls the diff and surrounding context, runs it through Atlarix Core, and posts inline comments plus a summary — same category as CodeRabbit. It runs **standalone** (full review on its own) and gets **better** when the author's side is Atlarix (reader/judge split). It reads code and reasons; it does **not** execute or test code. It reviews and can **approve**, but never merges.

The strategic point, not just the feature: Atlarix today is a private, local-first workstation that stops at the edge of your machine. The moment code becomes a PR it becomes a *team* artifact, and Atlarix currently has no presence there. The bot is Atlarix extending onto the team/collaboration surface without betraying the local-first identity — local authoring, independent team-side review. That's the whole reason it's on-thesis rather than a random second product.

---

## 2. Hard scope decisions (locked)

| Decision | Ruling |
|---|---|
| **Does it execute/test code?** | **No.** Read, reason, comment. No sandbox running untrusted code. This kills the biggest cost line *and* the biggest security surface (the RCE class of attack) in one move. |
| **Does it merge?** | **Never.** No auto-merge, ever. |
| **Does it approve?** | **Yes, allowed.** It can act as an approving reviewer (auto-approve) *if the repo permits it*. If the repo doesn't allow it as a formal approver, it falls back to a plain "LGTM" comment. No merge either way. |
| **Reader/judge handoff** | **Designed in now as core**, not deferred. Build the handoff protocol from the start. (Solo review still has to work fully on its own — see §5.) |
| **Model default** | **Atlarix Core is the default engine.** BYOK is the optional path. Free/promotional open-weight models are an optional cost-saving tier, never the backbone. |
| **Platform** | **GitHub only for v1.** Not GitLab, not Bitbucket. (Rationale in §9.) |

---

## 3. The core loop

Standard for the category — the moat is review quality, not the plumbing.

1. **Event fires** — GitHub sends a webhook on `pull_request` (opened/updated), `pull_request_review_comment`, and `issue_comment` (the last catches `@atlarix` mentions).
2. **Authenticate as the install** — per-install token, fine-grained repo permissions.
3. **Gather context (live, no clone)** — pull the diff, changed files, file contents at the ref, linked issue, PR description via the GitHub API. Reading is done live off the API — no repo clone needed for reason-only review (see §6).
4. **Build the fixed context structure** — your format-first idea: pin down *base repo + linked issue (if any) + diff + change rationale* into a bounded, structured payload before the model sees it. Bounded structured context = focused review + controlled token cost.
5. **Review** — run through Atlarix Core (reader/judge if Atlarix is the author, solo otherwise).
6. **Post back** — inline comments + summary. Approve / LGTM per §2.
7. **Log** — write the result to Supabase (for history, credit accounting, per-repo usage visibility).

---

## 4. Hosting — reuse what already exists

No new infrastructure. The bot is "the Atlarix proxy, triggered by a GitHub event instead of an app request."

- **Railway** = the always-on side. Webhook endpoint + orchestration + running Atlarix Core. The thing that's awake and doing work.
- **Supabase** = state. Installs, per-repo config, encrypted BYOK keys, review history, credits. The durable data.

Flow: GitHub → Railway endpoint → Railway authenticates install (Supabase lookup) → checks credits (Supabase) → runs review (Atlarix Core on Railway) → posts to GitHub → logs result (Supabase).

**Non-negotiable boundary:** even though there's no code-execution sandbox, keep the review work off any process that holds your secrets in a way that could leak them into output. Railway holds Supabase keys and model credentials; treat the review pipeline as untrusted-input-handling. (You cut the sandbox, so this is lighter than it would've been — but the instinct stays: the thing handling strangers' diffs is not the thing that should be able to spill your credentials.)

---

## 5. Reader / judge architecture (core)

This is the differentiator no competitor can copy, because no competitor has both the private local workstation *and* the reviewer.

- **When the author is Atlarix:** the local workstation authored the code and knows what it intended, what changed, why, and what it verified. It hands the bot a **structured context payload** — here's what changed, why, what was checked. The bot is the **independent judge**: it *verifies and probes the gaps*, it does not re-derive everything from the diff. Faster, cheaper, higher-signal.
- **When the author is not Atlarix (no payload):** the bot does the **full cold review on its own.** This is the fallback and it must be first-class — the whole addressable market is people who don't run Atlarix.

**The rule that keeps it honest:** the handoff is *evidence the judge checks*, never a verdict the judge rubber-stamps. If the bot just trusts Atlarix's "I tested this, it's fine," you've defeated the entire reason to have a separate reviewer — the author would be grading its own homework. Genuine independence even when it's your own model on both ends. This mirrors how good review works at all (reviewer perspective must differ from generator perspective) and how CodeRabbit already runs a separate judge model internally to verify findings before posting.

**Build order within this:** solo cold review working first → then wire the handoff as an *optional protocol* on top (if a PR carries an Atlarix context payload, use it; if not, cold path). Design the hooks in from the start; don't hard-couple the two products.

---

## 6. Reading strategy — live, not cloned

- **Reason-only review** (the default, most PRs): work **live off the GitHub API** — diff, changed files, file contents at a ref, linked issues. **No clone.** Fast, cheap, no checkout. This is what GitHub's own review AI and the lightweight reviewers do.
- **Deliberately out of scope:** anything requiring a checkout to a disk to *run* the code. Since we cut execution (§2), we don't need clones at all for v1. If execution ever comes back as a feature, the note on record is: push test execution into the PR's *own* GitHub Actions runner (runs on the user's Actions quota, in an environment already isolated from your backend) rather than cloning onto Railway. **Not v1. Recorded so the door isn't lost.**

---

## 7. The engine and the money side of it

### Default: Atlarix Core
Atlarix Core is the default review engine. This is the one place inference is *your* cost — and you already handle that correctly in the app: pay-as-you-go credits, metered, user-funded. The bot debits the **same credit meter** the app already uses (one credit system in Supabase, two products spending from it). You are not subsidizing inference; the user funds it. No loss-leader exposure.

### Optional: BYOK
User brings their own model key. Their key, their inference bill, your cost for inference = zero. With BYOK you are charging purely for the **product/platform**, not compute — so usage becomes irrelevant to your costs.

### Optional cost-saving tier: free/promotional open-weight models
Real, but unstable — the free model's bill is waived *at the provider* (a lab trades free compute for reach + training data), capped by rate limits. You tap this today by routing through **OpenRouter's free tier + direct provider free tiers** (you ride deals OpenRouter already brokered; you don't have the user-base leverage to strike your own yet). **Never build the bot's core on this** — free models rotate in and out and vary in quality, and review quality *is* the product. Offer it as an option; keep Core/BYOK as the reliable spine.

---

## 8. Pricing (structure + ballparks — treat numbers as starting knobs)

**Important margin note carried from the discussion:** don't ship a tier where the monthly fee is fully consumed by bundled inference credits. CodeRabbit can bundle credits into a flat price because they're funded buying market share. If you bundle Core credits, the price must be **base + credits**, not **base including credits** — otherwise your platform revenue on that tier is ~$0 and you're working for free.

### Recommended spine — Shape A (structurally safe)
- **Bot base fee:** ~$10–15/month. Covers the *platform* (the App, orchestration, pipeline, state). Independent of usage.
- **Atlarix Core:** billed **separately** on top — PAYG credits (same meter as the app) or BYOK. You never eat inference; the base fee is clean margin.
- **OSS / public repos:** free *as a product* (no base fee) **but BYOK or Core-credits required** for the inference. This is your distribution engine and it's on-thesis — but you do **not** eat OSS-volume inference on your own key. Optionally a tiny, hard-capped free-on-your-key trial purely as a funnel, ceiling set to what you can afford.
- **Private repos:** the base fee applies; Core metered or BYOK on top.

### Optional bundle — Shape B (only if the math is base-plus-credits)
If you want a CodeRabbit-style "one price" tier: e.g. **$20 base + $20 of Core credits included, priced at ~$35–40/mo** — *not* "$20 total split into bot + $20 credits." Bundle for convenience, but never give the whole fee back as inference.

### Approve/LGTM
No separate charge decided. (Earlier we floated "charge for the privileged action" — but since auto-**merge** is off the table entirely and only approve/LGTM remains, there's no risky privileged action to gate. Leave it included.)

### Guardrail to build from day one
A busy repo can open a *lot* of PRs. On any flat tier, meter **per-repo consumption** from the start (even if you don't act on it yet) so one whale repo reviewing 300 PRs/month can't quietly torch your margin. Credit-based billing or a per-repo PR cap on flat tiers protects you.

---

## 9. Platform scope & why GitHub-only

- **GitHub is "complete enough."** Git is ~universal as a protocol; the competition is at the hosting layer, and GitHub dominates it — and it's the only platform where your public-review self-marketing works, because it's where the developers (and your existing OSS footprint) are.
- **Bitbucket: skip outright.** It's sunsetting (Data Center new-license sales ended 2026, full EOL 2029). Building for a platform on a countdown is wasted effort.
- **GitLab: fast-follow only when a paying customer needs it.** Not for "looking complete."
- **The on-thesis expansion, if any, is the self-hosted forges (Gitea / Forgejo / Codeberg)** — because people self-host for *data sovereignty and anti-AI-training* reasons, which is *exactly* Atlarix's privacy buyer. That's a sharper fit than chasing Bitbucket's enterprises. **Later, not now.**

---

## 10. Account model & BYOK setup

The thing that makes "app-only / bot-only / both" resolve cleanly.

- **One Atlarix account = the hub.** The BYOK key and Core credits are properties of the **account**, not of either product.
- **Both products read the same account.** Set BYOK once → it powers app sessions *and* bot reviews. Bot-only user sets it once, only the bot uses it. App-only user never links a GitHub install.
- **Install → link flow:** user installs the GitHub App → GitHub redirects to your setup page → they log into / create their Atlarix account → that install is now tied to their account → from your dashboard they set the key, pick the model, set `.atlarix.yaml` defaults.
- **You already have this hub:** it's the existing Supabase users table. You're adding a "linked GitHub installs" relation and a BYOK field to the account you already model — not a new system.
- **Key security (build right the first time):** the BYOK key is a live credential to someone's paid model account. Encrypt at rest, never log it, never return it to the frontend after save (show `sk-…last4` only), scope who can read it. Treat it like a password because it effectively is one.

---

## 11. Per-repo config

- A **`.atlarix.yaml`** in the repo for per-project tuning — review depth, paths to ignore, severity thresholds, whether approve-as-reviewer is allowed. Table stakes for the category. Bounded, structured, and it's also where the "am I allowed to formally approve" flag lives (§2).

---

## 12. Distribution — the part that is NOT "list and wait"

- **The Marketplace is a storefront, not a marketing channel.** Listing makes you *findable by someone already searching*; it does not generate demand. List-and-wait = MS-Store silence. It's the checkout counter, not the foot traffic.
- **The demand engine is the public reviews themselves.** Every time the bot leaves a good review on a public PR, its handle is in the thread where your target developers are watching. That's how people discover these tools. And it's the *same* engine as your existing OSS distribution thesis — the bot's public reviews *are* Atlarix name-recognition in front of maintainers.
- **You are the first user — this solves the chicken-and-egg.** You already run an OSS PR strategy on named repos. Bootstrap:
  1. **Dogfood on your own private repos** (Atlarix, Tabibu, etc.) until the review quality is something *you'd* keep installed.
  2. **Attach it to the public PRs you're already making** into big-name repos — the bot reviews *your own* contribution in public, no maintainer install required, handle visible in the thread.
  3. **Then the social shoutout**, pointing at a real footprint of reviews ("here are 40 real reviews on [recognizable repos]") — not at an empty product.
- **Two cautions:** (a) quality bar is *higher* in public, not lower — a bad review on a big repo's thread is a negative ad; dogfood private until it's sharp. (b) Only review your *own* repos and your *own* contributions into public ones — auto-reviewing strangers' PRs uninvited reads as spam and gets you blocked.
- **Marketplace paid-listing has hoops** (verification, sometimes an install threshold). Sequence: **list free → build installs + public-review footprint → clear requirements → add paid plan.** Matches the build order anyway.

---

## 13. Review quality — the actual product (said plainly)

Everything above gets you a bot that *comments*. Getting one that comments *well* — sharp, low-noise, worth keeping installed — is the whole product and the bulk of the work. Teams uninstall reviewers that nitpick. Budget the real effort here:

- A **judge/verifier pass** before anything posts, to filter false positives (the thing that keeps it from crying wolf).
- **Context-selection logic** — what to feed the model beyond the raw diff (the cross-file reach is where real bugs hide and where naive reviewers miss).
- **Model eval on your own review task** before betting the product on any given open-weight model — don't trust benchmark blogs; a reviewer that misses real bugs or nitpicks gets uninstalled fast.

The plumbing is a couple of weekends. This is the couple of *months*. Don't let the fast start set expectations for the whole.

---

## 14. Rough timeline (focused-hours, solo)

- **~1 week:** bot leaves its first comment on a PR (exciting, not shippable).
- **~3–4 weeks:** standalone bot works end-to-end, dogfooding on your own private repos, BYOK/Core wired.
- **~2–3 months:** review quality good enough to defend on a public thread — ready to seed on your OSS PRs and do the shoutout.
- **After that:** paid private tier once there's traction; reader/judge polish; (much later) forge expansion.

**Caveats on record:** this is split against Deriv onboarding (~Oct), SPACInsider, Tabibu, the harness series — wall-clock will run longer than effort-hours suggest. The "fast start" is the trap; hold scope (you already cut sandboxing — keep that line). Every "oh and it could also…" resets the clock.

---

## 15. Build order (the sequence that falls out of all the above)

1. **GitHub App skeleton** — register the App, webhook → Railway, pull diff/context via API, run through Atlarix Core, post one comment back. The thing that visibly reviews a PR.
2. **Account linking + BYOK/Core on atlarix.dev** — install→link flow, encrypted key storage, the account-as-hub. Load-bearing; everything hangs off it.
3. **Solo cold review, made good** — the review-quality work (§13). The real product.
4. **`.atlarix.yaml` config + approve/LGTM logic.**
5. **Reader/judge handoff protocol** — the optional Atlarix-author path, wired on top of working solo review.
6. **Free-listing on Marketplace + dogfood → public-PR seeding** (§12).
7. **Paid private tier + per-repo metering guardrail** once traction shows.

---

*Open items still genuinely undecided (not blockers, just not yet chosen): exact base-fee number; whether to offer the Shape-B bundle at all; whether the free-model tier ships at launch or later; the precise `.atlarix.yaml` schema.*
