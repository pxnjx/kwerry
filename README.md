# Kwerry

Live SERP keyword research tool. Score keyword opportunity from real Google/Bing results, expand ideas from autocomplete & related searches, track history, and export Markdown/CSV reports.

Local-first · accounts & sessions · multi SerpAPI key pooling · bulk research · analytics.

## Requirements

- **Node.js 20+**
- A **[SerpAPI](https://serpapi.com)** API key

## Setup

```bash
git clone <this-repo> kwerry
cd kwerry

cp .env.example .env    # Windows: copy .env.example .env
npm start
```

Then edit `.env` — everything is configured there — and restart. Two things matter:

| Variable | Why |
|----------|-----|
| `SERPAPI_API_KEY` | Required to run searches. |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | Your sign-in. Leave the password empty and one is generated and printed once. |
| `ADMIN_USERNAME` | Set it to your username so only you can manage keys/billing/backups. |

Open **http://localhost:8765** (or the `PORT` you set) and sign in.

### Accounts come from `.env`, not a sign-up screen

On the first start with an **empty** database Kwerry creates one account from
`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`. There is no "Create account" tab —
registration is off by default and `POST /api/auth/register` answers 403. If you
deliberately want it, set `ENABLE_SIGNUP=true`.

Note that seeding only happens while the database has no users. Once your account
exists, editing those variables does nothing; to recover a forgotten password,
use **Settings → Change password** after signing in, or delete
`data/keyword-research.db` to start over (this erases all search history).

> **Note on exposure.** The server listens on every network interface, not just `localhost`, so anything on your network can reach the port. With sign-up closed the only account is yours, but still set `ADMIN_USERNAME` — it is what keeps any future account out of SerpAPI key management, billing, and backup/restore.

## Features

| Area | What you get |
|------|----------------|
| **Research** | Single keyword or bulk (up to 25), live SERP scoring (verdict / score / intent), keyword & wording ideas |
| **History** | Searchable log with notes, tags, pagination, open & delete |
| **Analytics** | KPIs, verdict/intent/score charts, top keywords & SERP domains |
| **Compare** | Side-by-side compare of two saved searches |
| **Export** | Markdown report (clickable titles + full URL list) and CSV |
| **Settings** | Multiple SerpAPI keys, change password, database backup & restore |

## Using it

1. **Sign in** with the first-run account.
2. Go to **Settings** and add your SerpAPI key(s). Multiple keys are pooled; when one hits quota/429 Kwerry tries the next.
3. Open **Research**, enter a keyword (or switch to **Bulk research**), pick engine/location/goal, run.
4. Keep organized: add **notes/tags** in **History**.
5. Export via **Report .md** on a result, or **Export CSV** in History.
6. Backup often: **Settings → Database backup**.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERPAPI_API_KEY` | yes* | Default key, seeded into Settings on first run |
| `SEED_ADMIN_USERNAME` | no | First-run admin username (default `admin`) |
| `SEED_ADMIN_PASSWORD` | no | First-run admin password (else random, printed once) |
| `ADMIN_USERNAME` | recommended | The only account allowed to manage SerpAPI keys, view billing, run backup/restore. Unset = every signed-in account can |
| `ENABLE_SIGNUP` | no | Off by default — no "Create account" tab. Set to `true` to allow registration |
| `PORT` | no | HTTP port (default `8765`) |

\*You can also skip `SERPAPI_API_KEY` and add keys later in **Settings**.

## Stack

- Node.js (no framework) + built-in `node:sqlite`
- React SPA (`web/`, built to `dist/`)
- [SerpAPI](https://serpapi.com) for live search data

## Project layout

```
server.js      HTTP API, auth, SERP client
db.js          SQLite schema, queries, backup/restore
web/           React UI (built to dist/)
dist/          Built app served by the API server
data/          SQLite database + backups (gitignored — never commit)
```

## Security notes

- Passwords are hashed with **scrypt**; sessions use HttpOnly cookies.
- Login is rate-limited (per IP).
- **Never commit** `.env` or `data/` — they contain API keys and your research database.
- This app is designed for **local / private** use. Put it behind a reverse proxy + HTTPS if you expose it on a network.

## License

[GNU Affero General Public License v3.0](LICENSE) — see [`LICENSE`](LICENSE).

If you run a modified version as an online service, AGPL-3.0 requires offering the corresponding source to your users.
