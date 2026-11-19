# Unified Gmail Hub

A mobile-first, single-origin Gmail hub for managing multiple authorized Gmail accounts in one interface.

## Stack

- Cloudflare Workers + Static Assets
- Cloudflare D1
- Cron Trigger every minute
- Inbox display choices: 7, 30, 90 rolling days, or all cached metadata
- D1 metadata retention is 90 days, capped at the 1,000 most recent messages
- Gmail history backfill runs incrementally while the recent inbox poll continues
- Google Gmail API
- OAuth access and refresh tokens encrypted at rest in D1; legacy plaintext access tokens are upgraded on use
- Vanilla JavaScript + Tailwind CSS CDN
- PWA manifest and offline shell

## Local development

```bash
npm install
npm run db:local
npm run dev
```

## Deployment

```bash
npx wrangler d1 execute unified-gmail-hub --remote --file=./schema.sql
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ENCRYPTION_KEY
npm run deploy
```

The Worker hostname and API must be protected by Cloudflare Zero Trust Access. Keep only the exact Google OAuth callback path bypassed so Google's redirect can reach the application.

## Production observability and failure alerts

Workers Logs, sampled Traces, and Workers Issues are enabled in the production configuration. Query strings are redacted from observability data because OAuth callback parameters and user searches may be present in URLs. Application logs use structured events and intentionally omit Gmail addresses, subjects, bodies, tokens, and raw provider responses.

Open **Workers & Pages → unified-gmail-hub → Observability** to review logs, traces, and detected issues. A Cloudflare email notification policy is configured for the Worker issue automation; the first detected issue triggers a notification. Cloudflare Logs and Traces have platform-defined retention and usage terms, so review Cloudflare's current Observability pricing before materially increasing traffic or sampling.

## PWA asset packaging

The Worker serves `public/` through the `ASSETS` binding on normal Wrangler deployments. A bundled fallback in `src/inline-assets.js` is also included for direct Worker API deployments where the static-asset upload API is unavailable. If you change a file in `public/` and need to refresh that fallback, run `npm run build:inline-assets`; CI checks it with `npm run check:inline-assets`.

Do not commit .dev.vars, .env, OAuth credentials, access/refresh tokens, or the encryption key.

## AI-assisted development and documentation grounding

This repository includes project-scoped Agent Skills under `.agents/skills/`:

- `retrieving-developer-knowledge` — a vendored, pinned Google skill for retrieving official Google developer documentation. Its upstream source, license, file hashes, and downstream adaptation are recorded in `UPSTREAM.md`.
- `unified-gmail-hub-development` — project-specific instructions for repository-first debugging, Google/Cloudflare documentation checks, security, regression tests, and evidence-backed deployment reports.

Repository-wide rules are in `AGENTS.md`. Coding agents that support repository-scoped Agent Skills (including Codex) discover skills from `.agents/skills/`. Restart or refresh the agent session if a new skill is not listed.

Only the relevant Google documentation skill is vendored; the full upstream repository contains many unrelated skills that are not dependencies of this application. These files guide coding agents only. They are **not** Worker runtime dependencies, are not deployed to Cloudflare, and cannot guarantee zero hallucinations. The intended safeguard is a combined workflow: inspect the current code, verify external facts against official documentation, add regression tests, and report only checks that actually ran.

To update the Google skill, review the upstream changes and update the pinned snapshot and provenance record together; do not blindly overwrite the project-specific adaptation.
