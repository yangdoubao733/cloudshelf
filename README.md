# CloudShelf

CloudShelf is a self-hosted cloud reader for personal EPUB and TXT libraries. It is designed for Chinese books first: TXT uploads support UTF-8, UTF-16, and GB18030 decoding, and full-text search builds extra CJK n-gram tokens so Chinese queries work without spaces.

## Features

- Password-protected web app with a single administrator account.
- Docker deployment with all persistent data mounted under `/data`.
- Upload EPUB and TXT books from browser.
- Read EPUB metadata: title, author, language, publisher, description, and cover.
- Extract readable text from EPUB/TXT and build a SQLite FTS5 full-text index.
- Sync reading progress, theme, font size, text color, background color, and left-hand mode.
- Responsive reading UI for desktop and mobile.
- Mobile left-hand mode with larger previous-page touch area and left-priority controls.

## Quick Start

Copy the example environment file first:

```bash
cp .env.example .env
```

Edit `.env` and set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`.

```bash
docker compose up -d --build
```

Open `http://localhost:8080`.

Default username:

```text
admin
```

The password is the `ADMIN_PASSWORD` value in `.env`. Change it before exposing the service to the internet.

## Local Development

CloudShelf currently targets Node.js 22 because it uses the built-in SQLite module.

```bash
npm install --cache .npm-cache
npm run dev
```

Then open `http://localhost:8080`.

If you do not set `ADMIN_PASSWORD`, the development password defaults to:

```text
cloudshelf
```

Run the smoke test:

```bash
npm run smoke
```

The smoke test starts a temporary server, logs in, uploads a Chinese TXT book, verifies Chinese full-text search, saves reading progress, and then removes its temporary data directory.

## Configuration

Environment variables:

| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` | Persistent database, books, and covers |
| `ADMIN_PASSWORD` | `cloudshelf` | Initial admin password for a fresh database |
| `SESSION_SECRET` | random on each boot | Cookie signing secret |
| `HOST_PORT` | `8080` | Host port exposed by Docker Compose |
| `MAX_UPLOAD_MB` | `200` | Maximum upload size in MB |
| `TRUST_PROXY` | `0` | Trust `X-Forwarded-Proto` from reverse proxy |
| `COOKIE_SECURE` | `0` | Force secure cookies for HTTPS deployments |

For production, always set `SESSION_SECRET` to a long random value. If it changes, existing login sessions become invalid.

For a full server setup, see [docs/production.md](docs/production.md).

## Docker Build Troubleshooting

If your server gets stuck at:

```text
RUN npm ci --omit=dev
npm error Exit handler never called!
```

it is usually an npm registry, audit, DNS, or IPv6 network issue inside Docker build. CloudShelf's Dockerfile disables npm audit/fund, defaults to the China-friendly npmmirror registry, and forces npm to replace lockfile tarball hosts with the selected registry.

Try a clean rebuild:

```bash
docker compose build --no-cache --progress=plain
docker compose up -d
```

If your server can access the official npm registry faster, change `.env`:

```env
NPM_REGISTRY=https://registry.npmjs.org
```

Then rebuild again.

Quick network checks on the server:

```bash
curl -I https://registry.npmmirror.com/adm-zip
curl -I https://registry.npmjs.org/adm-zip
```

Use the registry that responds reliably.

If the server can run Docker images but npm inside Docker cannot reach any registry, use the runtime compose file after uploading a package that already contains `node_modules`:

```bash
docker compose -f docker-compose.runtime.yml up -d
```

This avoids `npm ci` on the server. It is useful for restricted servers, but the standard `docker-compose.yml` remains the preferred path when registry access is reliable.

If the build hangs at `npm ping`, Docker cannot reliably reach the selected registry. Change `NPM_REGISTRY` or fix server/Docker DNS first.

If `npm ping` succeeds but `npm ci` hangs, run:

```bash
docker compose build --no-cache --progress=plain --build-arg NPM_REGISTRY=https://registry.npmjs.org
```

or try the mirror again:

```bash
docker compose build --no-cache --progress=plain --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

## Data Layout

```text
/data
  cloudshelf.db
  books/
  covers/
```

Back up the whole `/data` directory to preserve your library, metadata, search index, settings, and reading progress.

## Roadmap

- Per-book table of contents for EPUB.
- Highlighting and notes.
- Multi-user accounts.
- OPDS feed for external readers.
- Optional Meilisearch backend for larger Chinese libraries.
- PWA offline cache for recently opened books.

## Security Notes

EPUB files are uploaded by trusted users only. CloudShelf extracts EPUB metadata and readable text on the server, then serves a simplified chapter reader instead of executing EPUB scripts in the browser. If you plan to allow untrusted uploads, add deeper archive validation and run CloudShelf behind a reverse proxy with HTTPS.
