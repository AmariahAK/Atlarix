# Credentials setup (CI and local dev)

This guide lists **what each secret is for** and where it is used. Obtain values from your vendors (Lemon Squeezy, Auth0, Supabase, etc.); do not commit real secrets to the repository.

For the **full list** of GitHub Actions secret names, see [README.md](../README.md) → **Deployment & CI/CD** and [SECRETS.md](../SECRETS.md).

## Compass (v5.1+)

Used only in the **Electron main** bundle (`vite.main.config.mts` → `MAIN_KEYS`). Not exposed to the renderer.

| Secret / env var | Purpose |
|------------------|---------|
| `COMPASS_OPENROUTER_API_KEY` | API key for OpenRouter (managed Compass traffic). |
| `COMPASS_MODEL_FAST` | OpenRouter model id for Compass Fast. |
| `COMPASS_MODEL_BALANCED` | OpenRouter model id for Compass Balanced. |
| `COMPASS_MODEL_THINKING` | OpenRouter model id for Compass Thinking. |

Add the same names to **GitHub Actions** repository secrets so `release.yml` can pass them into the build.

## Local development

For local `npm run start` / `make`, you can set the same variables in a root `.env` file if your workflow loads it (optional). Leave values empty if you are only testing BYOK providers without Compass.
