# Kwerry

Live SERP keyword research tool. Score keyword opportunity from real Google/Bing results, read the AI Overview and its citations, expand ideas from autocomplete & related searches, track history, and export Markdown/CSV reports.

Local-first · accounts & sessions · multi SerpAPI key pooling · bulk research · analytics.

## Requirements

- **Node.js 22.13+** (or 23.4+). `db.js` uses the built-in `node:sqlite` module, which does not exist before Node 22.5 and needs a runtime flag before 22.13 — on Node 20 the server cannot even boot.
- A **[SerpAPI](https://serpapi.com)** API key

## Setup

```bash
git clone <this-repo> kwerry
cd kwerry

npm install
cp .env.example .env    # Windows: copy .env.example .env
```

Fill in `.env`, then **build the UI and start the server**:

```bash
npm run build
npm start
```

> `npm run build` is not optional. The API server serves the interface from `dist/`, and `dist/` is gitignored — a fresh clone has no UI until Vite builds it. `npm start` alone gives you a working API and 404 pages.

Then restart after editing `.env` — everything is configured there. Three things matter:

| Variable | Why |
|----------|-----|
| `SERPAPI_API_KEY` | Required to run searches. |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | Your sign-in. Leave the password empty and one is generated and printed once. |
| `ADMIN_USERNAME` | Set it to your username so only you can manage keys/billing/backups. |

Open **http://localhost:8765** (or the `PORT` you set). A public landing page lives at `/`; the app itself is behind sign-in.

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
| **AI Overview** | Presence check, full outline, mentions and a citation table with per-domain breakdown |
| **Google Trends** | 12-point interest series with an inline sparkline and rising / falling / stable direction |
| **SERP** | Organic results, detected features (PAA, related, shopping, local, ads, images, videos, news, knowledge panel, featured snippet) |
| **Keyword clusters** | Suggestions grouped into topical clusters instead of one flat list |
| **Content brief** | Outline, title ideas, FAQ from People Also Ask, secondary keywords, entities, word-count target |
| **History** | Searchable log with notes, tags, pagination, open & delete |
| **Analytics** | KPIs, verdict/intent/score charts, search activity per day, top keywords & SERP domains |
| **Compare** | Side-by-side compare of two saved searches |
| **Export** | Markdown report (clickable titles + full URL list) and CSV |
| **Quota** | Per-key plan usage, monthly reset countdown and hourly rate limit, plus a live badge on the Research page |
| **Settings** | Multiple SerpAPI keys (enable/disable, delete), change password, database backup & restore |
| **Interface** | Light & dark themes, responsive sidebar with a mobile drawer, public landing page |

### Caching

SERP responses, autocomplete, Trends and AI Overview are cached in SQLite for 24 hours
per user + keyword + engine + location. Re-running the same research costs nothing and
returns the cached payload. `POST /api/cache/clear` empties it. Autocomplete tries the
free Google Suggest endpoint first, so idea expansion usually spends no SerpAPI quota.

## Development

The server and the UI run separately in dev — Vite serves the React app with hot reload
and proxies `/api` to the Node server.

```bash
npm run dev:api   # API on :8766
npm run dev       # Vite UI on :8765, proxying /api -> :8766
```

On Windows, `run.bat` does both: it frees the ports, bumps them if something else is
holding them, opens the two windows and launches the browser.

| Script | What it does |
|--------|--------------|
| `npm start` | Production: serves `dist/` + the API from one Node process on `PORT` (8765) |
| `npm run dev:api` | API only, pinned to port 8766 |
| `npm run dev` | Vite dev server with HMR on 8765 |
| `npm run build` | Builds the UI into `dist/` |
| `npm run preview` | Serves the built `dist/` through Vite |

`API_DEV_URL` overrides the dev proxy target (default `http://127.0.0.1:8766`).

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
| `TRUST_PROXY` | no | Set to `true` only when a reverse proxy you control sets `X-Forwarded-Proto`. It marks the session cookie `Secure` over HTTPS; the header is attacker-controlled without a proxy in front |
| `PORT` | no | HTTP port (default `8765`) |
| `API_DEV_URL` | no | Dev only — Vite proxy target for `/api` (default `http://127.0.0.1:8766`) |

\*You can also skip `SERPAPI_API_KEY` and add keys later in **Settings**.

## Stack

- Node.js (no framework) + built-in `node:sqlite`
- React 19 + Vite (`web/`, built to `dist/`)
- [SerpAPI](https://serpapi.com) for live search data

## Project layout

```
server.js         HTTP API, auth, SERP client, caching, export
db.js             SQLite schema, queries, backup/restore
web/              React UI source
web/src/pages/    Research, History, Analytics, Compare, Settings, Login, Home
web/src/components/  Shell (sidebar/nav), QuotaBadge, ThemeToggle, icons
dist/             Built app served by the API server (gitignored)
data/             SQLite database + backups (gitignored — never commit)
run.bat           Windows dev launcher (API + Vite, handles busy ports)
vite.config.mjs   Dev proxy + build output
```

## Security notes

- Passwords are hashed with **scrypt**; sessions use HttpOnly cookies.
- Login is rate-limited (10 failures per IP per 15 minutes).
- The server binds **every** network interface — anyone who can reach the port can reach the API.
- **Never commit** `.env` or `data/` — they contain API keys and your research database.
- This app is designed for **local / private** use. Put it behind a reverse proxy + HTTPS if you expose it on a network, and set `TRUST_PROXY=true` there so the session cookie gets the `Secure` flag.

## License

[GNU Affero General Public License v3.0](LICENSE) — see [`LICENSE`](LICENSE).

If you run a modified version as an online service, AGPL-3.0 requires offering the corresponding source to your users.
