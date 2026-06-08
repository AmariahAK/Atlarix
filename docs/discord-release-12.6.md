# Atlarix v12.6.0 — Discord technical post

> Paste-ready for the announcements channel. Small, focused follow-up to v12.5.

---

**Atlarix v12.6.0 released** 🔑

Release notes (technical):

A quick sign-in fix.

- **Real OAuth buttons are back:** after logging out, the sidebar — and the welcome screen and the full sign-in page — were showing only the animated Atlarix mark with "Click to sign in" (Google-only, easy to miss). They now render proper **"Continue with Google"** and **"Continue with GitHub"** buttons. The Supabase OAuth wiring was always intact (`auth:sign-in` → `SubscriptionManager.signIn`); only the UI had regressed to an animation-only control. Restores the v9.0.0 button UI, now driven by `useAuth()` so the in-flight OAuth spinner/status is preserved.
- **Log out / sign in from the welcome screen:** the home/workspace-selector header now has a **Sign out** control next to "Settings & account", and when signed out it shows the Google/GitHub buttons directly — no need to open the sidebar.
- Under the hood: one reusable `OAuthSignInButtons` component now powers every sign-in surface (sidebar, welcome, sign-in page), so providers stay consistent everywhere.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
