# Unified Gmail Hub

A mobile-first, single-origin Gmail hub for managing multiple authorized Gmail accounts in one interface.

## Stack

- Cloudflare Workers + Static Assets
- Cloudflare D1
- Cron Trigger every minute
- Google Gmail API
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

Do not commit .dev.vars, .env, OAuth credentials, refresh tokens, or the encryption key.
