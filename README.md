Cloudflare Workers mail version
===============================

This folder contains a Cloudflare Workers rewrite of Forsaken Mail that keeps the existing frontend untouched while replacing the backend with Workers Email + D1.

Features
--------
- Workers Email handler stores incoming messages into D1 and blocks senders/domains via env vars.
- Socket.IO-compatible long-polling endpoint for the existing UI (`/socket.io/`), including shortid assignment and live mail pushes.
- Static assets served from `public` via the Workers asset binding.
- Scheduled cleanup that removes messages older than 7 days.
- On-page load, the worker lazily ensures the D1 schema exists (table + indexes).

Running locally
---------------
1) Install `wrangler` if you have not already.
2) Update `worker_version/wrangler.toml` with your D1 binding and env vars:
   - `MAIL_DOMAIN`: domain configured for Workers Email routing (no auto-detection).
   - `PRE_BLACKLIST`: comma-separated mailbox prefixes to block.
   - `BAN_SEND_FROM_DOMAIN`: comma-separated sender domains to reject.
3) Create the D1 database and attach it to the binding `DB`.
4) Run `wrangler dev --config worker_version/wrangler.toml`.

Deploying
---------
1) Add an Email Worker route for the same worker so inbound mail hits the `email` handler.
2) Deploy with `wrangler deploy --config worker_version/wrangler.toml`.
3) Ensure MX/SMTP routing to Cloudflare is configured for `MAIL_DOMAIN`.
