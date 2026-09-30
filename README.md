# Kwerry

Live SERP keyword research tool. Score keyword opportunity from real Google/Bing results, expand ideas from autocomplete & related searches, track history, and export Markdown/CSV reports.

Local-first · accounts & sessions · multi SerpAPI key pooling · projects · bulk research · analytics.

## Requirements

- **Node.js 20+**
- A **[SerpAPI](https://serpapi.com)** API key

## Setup

```bash
git clone <this-repo> kwerry
cd kwerry

cp .env.example .env
# edit .env → set SERPAPI_API_KEY
# optional: set SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD

npm start
```

Open **http://localhost:8765** (or the `PORT` you set).

### First-run account

On first start, if no users exist yet Kwerry creates an admin account:

- If `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` are set in `.env`, those are used.
- Otherwise username is `admin` and a **random password is printed once** in the server terminal — copy it, sign in, then change it under **Settings → Change password**.

You can also create more accounts anytime from the login page.

## Features

| Area | What you get |
|------|----------------|
| **Research** | Single keyword or bulk (up to 25), live SERP scoring (verdict / score / intent), keyword & wording ideas |
| **History** | Searchable log with notes, tags, projects, pagination, open & delete |
| **Analytics** | KPIs, verdict/intent/score charts, top keywords & SERP domains |
| **Compare** | Side-by-side compare of two saved searches |
| **Export** | Markdown report (clickable titles + full URL list) and CSV |
| **Settings** | Multiple SerpAPI keys, change password, database backup & restore |

## Using it

1. **Sign in** with the first-run account.
2. Go to **Settings** and add your SerpAPI key(s). Multiple keys are pooled; when one hits quota/429 Kwerry tries the next.
3. Open **Research**, enter a keyword (or switch to **Bulk research**), pick engine/location/goal/project, run.
4. Save organization: use **Projects** on the form; add **notes/tags** in **History**.
5. Export via **Report .md** on a result, or **Export CSV** in History.
6. Backup often: **Settings → Database backup**.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERPAPI_API_KEY` | yes* | Default key, seeded into Settings on first run |
| `PORT` | no | HTTP port (default `8765`) |
| `SEED_ADMIN_USERNAME` | no | First-run admin username (default `admin`) |
| `SEED_ADMIN_PASSWORD` | no | First-run admin password (else random) |

\*You can also skip `SERPAPI_API_KEY` and add keys later in **Settings**.

## Stack

- Node.js (no framework) + built-in `node:sqlite`
- Static frontend in `public/`
- [SerpAPI](https://serpapi.com) for live search data

## Project layout

```
server.js      HTTP API, auth, SERP client
db.js          SQLite schema, queries, backup/restore
public/        UI (research, analytics, history, compare, settings, login)
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
