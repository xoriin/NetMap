# Contributing to NetMap

Run the FastAPI backend and Vite frontend in two terminals for local development.
Docker is optional for this workflow; use it when testing the packaged application
or network features that need the container's tools and permissions.

## Prerequisites

- Git
- Python 3.12+ and [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Node.js 22.12+ and npm (CI uses Node.js 22)
- Docker with Compose, if you want to test the container

The commands below use Bash.

## Get the code

Fork [xoriin/netmap](https://github.com/xoriin/netmap), clone your fork, and start
a branch from `test`:

```bash
git clone https://github.com/YOUR_USERNAME/netmap.git
cd netmap
git switch test
git switch -c fix/describe-your-change
```

For an existing checkout, run `git switch test` and `git pull --ff-only` before
creating your feature branch.

## Run locally

### Terminal 1: Python backend

From the repository root, install the locked Python dependencies, including the
development tools. uv creates a virtual environment in `backend/.venv`:

```bash
cd backend
uv sync --locked --extra dev
```

Create `backend/.env` once with local settings and generated keys:

```bash
uv run python - <<'PY'
from pathlib import Path
import secrets
from cryptography.fernet import Fernet

with Path(".env").open("x") as env:
    env.write(
        "APP_ENV=development\n"
        "DATA_DIR=../data\n"
        "DATABASE_URL=sqlite:///../data/netmap.db\n"
        "APP_URL=http://localhost:5173\n"
        'CORS_ORIGINS=["http://localhost:5173"]\n'
        'TRUSTED_HOSTS=["localhost","127.0.0.1"]\n'
        "SYSLOG_ENABLED=false\n"
        f"SECRET_KEY={secrets.token_urlsafe(48)}\n"
        f"MASTER_KEY={Fernet.generate_key().decode()}\n"
    )
PY
```

This refuses to overwrite an existing `.env`. If you already have one, edit its
local settings instead. Keep both keys stable across restarts and keep `.env`
out of commits. The database and other local data are stored in the ignored
`data/` directory at the repository root. Use separate development data, not a
production database.

Start the API from `backend/`:

```bash
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8090
```

The backend creates its databases and applies migrations on startup. You can
check it at <http://127.0.0.1:8090/api/v1/health>.

Prefer a standard Python virtual environment? Instead of `uv sync`, use:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
```

Then run the same setup snippet with `python` instead of `uv run python`, and
start the API with `python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8090`.

### Terminal 2: Vite frontend

Open a second terminal at the repository root:

```bash
cd frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Open <http://localhost:5173> and complete the setup wizard to create your first
admin account. Keep both terminals running. Vite reloads frontend changes;
Uvicorn reloads Python changes.

Vite proxies `/api` requests, including WebSockets, to `http://127.0.0.1:8090`.
If you change the backend port, set the target when starting Vite:

```bash
VITE_API_TARGET=http://127.0.0.1:8091 npm run dev -- --host 127.0.0.1
```

Use the Vite URL in your browser. If Vite selects a different port because 5173
is busy, free that port or update `APP_URL` and `CORS_ORIGINS` to match and restart
the backend.

### Optional: test the Docker container

From the repository root, copy `.env.example` to `.env`, generate and fill in
`SECRET_KEY` and `MASTER_KEY` as described in that file, and set:

```dotenv
CORS_ORIGINS=["http://localhost:8080"]
TRUSTED_HOSTS=["localhost","127.0.0.1"]
APP_URL=http://localhost:8080
```

The key-generation command for `MASTER_KEY` needs `cryptography`; you can run it
with `uv run python` from the backend environment created above. Then, from the
repository root:

```bash
docker compose -f docker-compose.build.yml up --build -d
```

Open <http://localhost:8080>. This builds a local image from your checkout.
The regular `docker-compose.yml` pulls the published image instead.

Host development does not bundle `nmap`, `ping`, traceroute or SNMP tools.
Features that call these commands need the host tools and appropriate permissions;
discovery also invokes `sudo nmap`. Use Docker to check the packaged environment.
MAC discovery needs direct access to the local network; Docker bridge networking
cannot provide the same ARP visibility as host networking on Linux. The local
Python configuration above disables the syslog listener; enable it explicitly
when working on syslog ingestion.

## Check your changes

From `backend/`:

```bash
uv run --locked --extra dev ruff check .
uv run --locked --extra dev pytest tests
```

With an activated standard virtual environment, use `ruff check .` and
`python -m pytest tests` instead.

From `frontend/`:

```bash
npm run build
npm exec playwright install chromium
npm exec playwright test
```

The build includes TypeScript checking. Install Chromium on the first browser
test run; Linux may also need `npm exec playwright install --with-deps chromium`.
Playwright serves the built `dist/` directory, so rebuild after frontend edits
before running it. Stop any old preview server on port 4173 to avoid testing a
stale build.

Add a regression test for fixes where practical. For UI changes, also check the
running app in light and dark themes, at desktop and narrow widths, with the
relevant loading, empty and error states. Container startup or migration changes
also need the image compatibility check:

```bash
python3 scripts/smoke-image.py netmap:local-aio --previous-image xoriin/netmap:latest --platform linux/amd64
```

Run that from the repository root after building the local image. It uses
disposable containers and volumes, not your development data.

## Code conventions

- Keep changes focused and follow the surrounding implementation.
- Use typed React components and the shared `nm-*` controls, components and theme
  tokens. Keep `styles/global.css` as an import index.
- Keep API handlers thin; shared backend logic belongs in `backend/app/services/`.
- Database migrations are registered in `backend/app/db/session.py`, not Alembic
  migration files. Test fresh installs, upgrades and preservation of existing data.
- Keep secrets, databases, virtual environments and generated files out of commits.

## Open a pull request

Push your feature branch to your fork and open a PR against **`xoriin/netmap:test`**.
Briefly explain the change, why it is needed, and what you tested; include
screenshots for UI changes and reference any related issue.

I'll review and test changes on `test`, then merge them into `main` once they're
ready.

## Bugs and feature requests

Open an [issue](https://github.com/xoriin/netmap/issues) with the version, steps to
reproduce, expected behaviour and relevant logs. For feature requests, describe
the use case and what you want to achieve.
