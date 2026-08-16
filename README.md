# n8n Analytics Dashboard

> [!NOTE]
> This is a **test project**, free to use and open to the community. We welcome suggestions and contributions to make it better for everyone!

A high-performance analytics dashboard for **self-hosted n8n** instances. It syncs execution metadata out of your n8n PostgreSQL into a local SQLite replica and serves every chart, table, and AI query from that replica — so your production database never carries analytical load.

## 📸 Screenshots

| Main Dashboard | Error Intelligence |
|:---:|:---:|
| ![Main Dashboard](documentation/images/main.png) | ![Error Intelligence](documentation/images/error.png) |

<br>

| ROI Analytics | Mobile Responsiveness |
|:---:|:---:|
| <img src="documentation/images/roi.png" width="800"> | <img src="documentation/images/mobile_main.jpg" height="400"> |

### 🧩 Detailed Widgets

| Execution Volume | Error Hotspots |
|:---:|:---:|
| ![Execution Volume](documentation/images/main_exec_volume_daily.png) | ![Error Hotspots](documentation/images/main_error_hotspots.png) |
| **Execution Logs** | **Slowest Workflows** |
| ![Execution Logs](documentation/images/main_executions_rows.png) | ![Slowest Workflows](documentation/images/main_slowsest_workflows.png) |

---

## 🎯 Who is this for?

Anyone running their own n8n instance who wants long-horizon analytics without migrating to n8n Cloud or buying an enterprise license.

n8n 2.x does ship insights tables in self-hosted installs, but **how much of that surfaces in the editor UI depends on your license tier**, and n8n prunes execution rows aggressively by default. This dashboard fills both gaps:

- **Long-horizon history.** The local replica keeps rows that n8n has already pruned from PostgreSQL. Once a row is synced, it stays — the archive grows well past your n8n retention window.
- **Zero load on production.** All analytics and AI queries run against the SQLite replica, not your n8n database.
- **Operational depth.** Node-level failure analysis, upstream "brittle path" origins, ROI tracking, and natural-language querying.
- **Your hardware, your data.** Nothing leaves your infrastructure except the AI Assistant's calls to OpenAI, which is optional.

---

> [!IMPORTANT]
> **Hard requirements**
> 1. **Self-hosted n8n only** — the ETL needs direct database access.
> 2. **PostgreSQL only** — n8n must be configured with Postgres. The default n8n SQLite backend is not supported.
> 3. **A persistent volume for the replica** — see [Docker installation](#docker-installation). This is the single most common cause of data loss.
> 4. **Exactly one instance** — see [Scaling constraints](#-scaling-constraints).

> [!WARNING]
> **Version compatibility**
> The ETL reads a minimal slice of n8n's schema (`workflow_entity`, `execution_entity`, and `execution_data` on demand — metadata columns only, no workflow definitions). Built and tested against **n8n 2.x on PostgreSQL 17**; n8n 1.x is expected to work but is not actively verified. A major n8n schema change may require a sync-job update, but day-to-day analytics are unaffected because they run off the local replica.

---

## 🚀 Key Features

- **Real-time metrics** — total executions, error counts, average runtimes, period-over-period deltas.
- **Execution timeline** — successes vs. errors over 24h, 48h, 7d, 14d, 30d, or a custom date range, with active-bucket forecasting so the current partial bucket doesn't read as a crash.
- **Error Intelligence** — node-level failure analysis, deduplicated error groups, category breakdown (`rate_limit`, `auth`, `network`, `config`, `data`, `logic`, `upstream`), and the upstream origin nodes that triggered each crash.
- **ROI Analytics** — assign manual time-saved and hourly rates per workflow; get financial trends over time.
- **Deep-linking** — one click from a failing execution into the n8n workflow editor.
- **AI Analytics Assistant** — natural-language questions answered via a text-to-SQL pipeline ("Which workflow was slowest yesterday?").
- **Audit extracts** — CSV/JSON exports with execution IDs, error stacks, and metadata.
- **Security defaults** — JWT auth against your existing n8n users, rate limiting, strict CSP, sanitized rendering.

---

## 🏗️ How it works

```
n8n PostgreSQL  ──ETL every 5 min──▶  dashboard.sqlite  ──▶  Express API  ──▶  Browser UI
                                            ▲                                      │
                                            └──────────  AI text-to-SQL  ◀─────────┘
```

The ETL (`node-cron`) copies a narrow set of columns from n8n's `workflow_entity` and `execution_entity` into the local replica, and extracts structured error details from failed executions. Everything the dashboard renders is read from the replica.

PostgreSQL is contacted in exactly three places:
1. The ETL sync (read-only, every `SYNC_INTERVAL_MINUTES`).
2. Login — `bcrypt` comparison against n8n's `user` table.
3. On-demand raw trace fetch — a single row from `execution_data` when you click **Inspect** on a specific failed execution.

Nothing in the codebase writes to your n8n database.

### Enabling deep historical analytics

n8n prunes execution data frequently by default. To build long-term trends, raise the retention window on your **n8n instance**:

```env
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=720   # hours; see n8n docs for the unit in your version
```

> [!NOTE]
> Raising n8n's retention grows your **PostgreSQL** database. The dashboard's replica stores only lightweight metadata — no workflow definitions, no execution payloads — so it stays small by comparison. Note also that pruning in n8n never removes rows already synced into the replica, so the archive keeps growing even if you leave n8n's defaults alone.

---

## 🧱 Security & data privacy

### What is synced

| Source | Columns copied |
|---|---|
| `workflow_entity` | `id`, `name`, `active` |
| `execution_entity` | `id`, `workflowId`, `status`, `startedAt`, `stoppedAt` |

The `nodes` column (workflow definitions, credentials references) and the `data` payload of successful executions are **never** copied.

### What the error extractor does store

When an execution fails, the ETL parses its payload and stores a structured record in `execution_error_analytics`: node name and type, error type, error message, error category, timestamp — and also `error_stack`, `metadata`, and `input_data`.

> [!CAUTION]
> **`input_data` and `error_stack` can contain production data.** They hold the item that was being processed when the node threw, which may include customer records, tokens, or anything else flowing through the failing workflow. This is what makes the error modal genuinely useful for debugging — and it means the replica is not free of sensitive data.
>
> Two consequences:
> - Treat `dashboard.sqlite` with the same care as your n8n database.
> - The AI Assistant currently executes any read-only SQL it generates against the replica, so it *can* reach these columns. A column-level allowlist is planned; until then, do not expose the AI chat to users you would not trust with the error modal.

### Guarantees that do hold

- **Read-only against n8n.** No `INSERT`/`UPDATE`/`DELETE` path to your n8n database exists anywhere in the code.
- **No SQL mutation locally.** The AI pipeline rejects anything that is not a `SELECT`/`WITH`, and blocks DML/DDL keywords.
- **Air-gapped from production.** AI-generated SQL runs against the local SQLite file. Even a malicious query has no route to your Postgres server.
- **Helmet + strict CSP.** `script-src-attr 'none'`, no `unsafe-inline`, no external `connect-src`. Rendered markdown passes through DOMPurify with a restricted tag allowlist.

---

## 🔐 Authentication

The dashboard has no user management of its own — it authenticates directly against your n8n user base.

- **Same credentials.** Log in with the exact email and password you use for n8n.
- **Bcrypt matching.** Your input is compared against the hash in n8n's `user` table. The raw password is never stored or logged.
- **Pass-through identity.** Change your n8n password and it takes effect here immediately.
- **Disabled and MFA-enabled accounts are rejected.** Users with `disabled = true` cannot log in. Users with MFA enabled are blocked with an explanatory message, because the dashboard cannot verify the second factor.

Sessions are JWTs signed with `DASHBOARD_JWT_SECRET`. The server refuses to boot if that secret is shorter than 32 characters.

---

## 🖥️ Stack

**Backend** — Node.js + Express 5, modular MVC:

| Path | Role |
|---|---|
| `src/config/db.js` | PostgreSQL connection pool (n8n source) |
| `src/config/localDb.js` | SQLite replica: schema, pragmas, indexes, batch helpers |
| `src/config/syncJob.js` | The ETL and the error classification engine |
| `src/config/openai.js` | OpenAI client initialization |
| `src/controllers/` | Analytics, auth, and AI business logic |
| `src/middlewares/` | `auth.js` (JWT verification), `rateLimiter.js` |
| `src/routes/` | Endpoint → controller mapping |
| `src/scripts/optimizeReplica.js` | Offline replica maintenance (dry-run by default, `--apply` to commit) |

**Frontend** — vanilla JS and the standard DOM API, no bundler and no JS build step. Chart.js and marked are loaded from a CDN; DOMPurify is vendored locally under `public/vendor/`. Tailwind CSS v4 **is** compiled — run `npm run build:css` after editing `public/css/input.css` (or `npm run watch:css` while developing).

**Replica tuning** — on boot the app enables WAL journaling, sets a 5s busy timeout, and creates seven indexes covering the dashboard's access patterns. This is idempotent and costs a few seconds on a fresh database.

---

## 🤖 AI Chat Assistant

A three-step text-to-SQL pipeline:

1. **Intent → SQL.** Your question plus the replica schema go to the model, which returns SQLite.
2. **Guarded execution.** The query must be a `SELECT` or `WITH`; DML/DDL keywords are rejected. It runs against `dashboard.sqlite`.
3. **Results → prose.** The rows go back to the model for a human-readable answer.

The generated SQL is shown alongside every answer, so you can always check what was actually asked. Requires `OPENAI_API_KEY`; the rest of the dashboard works without it.

---

## 🛠️ Installation

### Prerequisites

- **Node.js 18+** (the Docker image uses `node:18-alpine`)
- **PostgreSQL access** to your n8n database — read-only credentials are enough; the dashboard never writes to it
- **OpenAI API key** — only if you want the AI Assistant

### Environment (`.env`)

```env
# --- Server ---
DASHBOARD_PORT=3000
# Minimum 32 characters. The server refuses to boot below that.
# Generate with: openssl rand -base64 48
DASHBOARD_JWT_SECRET='your_secure_random_secret'

# --- Replica location ---
# In Docker this MUST point inside a mounted volume.
# Omit for local development (defaults to ./dashboard.sqlite).
#DASHBOARD_DB_PATH=/data/dashboard.sqlite

# --- n8n PostgreSQL ---
DASHBOARD_DB_USER=postgres
DASHBOARD_DB_HOST=your_db_host
DASHBOARD_DB_NAME=n8n_data
DASHBOARD_DB_PASS=your_password
DASHBOARD_DB_PORT=5432
# Alternative to the five vars above:
#DASHBOARD_DATABASE_URL=postgres://user:pass@host:port/n8n_data?sslmode=disable

# --- n8n editor deep-links ---
N8N_EDITOR_BASE_URL=https://your-n8n-instance.com

# --- AI Assistant (optional) ---
OPENAI_API_KEY=sk-proj-your-key-here

# --- ETL ---
SYNC_INTERVAL_MINUTES=5          # optional, defaults to 5
#SAVE_DEBUG_ERRORS=true          # dumps raw JSON traces to disk for troubleshooting
```

### Standard installation

```bash
npm install
npm run build:css     # only needed if you change public/css/input.css
npm start             # → http://localhost:3000
```

### Docker installation

> [!CAUTION]
> **You must mount a volume at `/data`.**
> The replica holds execution history that n8n has already pruned from PostgreSQL — **it cannot be rebuilt from the source database**. Without a volume the replica lives inside the container and every redeploy destroys the entire archive, leaving you with only whatever still exists in n8n's retention window.

```bash
docker build -t n8n-dashboard .
docker volume create n8n_dashboard_data
docker run -d --name n8n-dashboard -p 3000:3000 \
  --env-file .env \
  -v n8n_dashboard_data:/data \
  n8n-dashboard
```

#### Docker Compose

```yaml
services:
  dashboard:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      DASHBOARD_DB_PATH: /data/dashboard.sqlite
    volumes:
      - dashboard_data:/data
    restart: unless-stopped

volumes:
  dashboard_data:
```

#### Easypanel / other PaaS

Add a **Volume** mount *before* your first deploy:

| Setting | Value |
|---|---|
| Type | Volume |
| Name | `dashboard-data` |
| Mount path | `/data` |

The image already defaults `DASHBOARD_DB_PATH` to `/data/dashboard.sqlite`, so the mount alone is enough — but setting the variable explicitly documents the dependency.

Note that the volume is created when the first container starts, not when you save the configuration, and platforms typically namespace it as `<project>_<service>_<volume>`.

---

## ⚖️ Scaling constraints

> [!WARNING]
> **Run exactly one instance. This is an architectural limit, not a tuning preference.**

The replica is a single SQLite file and the ETL is a single writer. Two processes pointed at the same file will corrupt it — and they will do so *quietly*: in testing, `PRAGMA integrity_check` returned `ok` on a file that had silently lost 86% of its rows.

Practical rules:

- Keep the service at **1 replica**. Do not scale horizontally.
- On **Docker Swarm** (which Easypanel and several PaaS providers use underneath), set the update order to `stop-first`:
  ```bash
  docker service update --update-order stop-first <service>
  ```
  With the default `start-first`, Swarm briefly runs the new and old tasks together — both writing the same file.
- On Swarm, stop and start **only** with `docker service scale <service>=0` / `=1`. Using `docker stop`/`docker start` leaves an orphan container that Swarm does not manage and that keeps writing to the replica.

---

## 💾 Backup, restore, and verification

The replica is the only copy of pruned history. Back it up on a schedule:

```bash
docker exec n8n-dashboard \
  sh -c 'sqlite3 /data/dashboard.sqlite ".backup /data/backup.sqlite"' \
  && docker cp n8n-dashboard:/data/backup.sqlite ./dashboard-$(date +%F).sqlite
```

### Migrating an existing replica into a volume

**Stop the app first.** Copying a file out from under a live writer produces a corrupt result.

```bash
docker stop n8n-dashboard                                    # or: docker service scale <svc>=0
docker cp dashboard.sqlite n8n-dashboard:/data/dashboard.sqlite
docker start n8n-dashboard                                   # or: docker service scale <svc>=1
```

### Verifying a copy or a backup

> [!IMPORTANT]
> `PRAGMA integrity_check` proves the file is *structurally* valid. It does **not** prove the data is complete — it will happily return `ok` on a truncated replica.

Verify both:

```bash
# 1. Structural
sqlite3 backup.sqlite "PRAGMA integrity_check;"          # expect: ok

# 2. Content — compare against the source
sqlite3 backup.sqlite "SELECT COUNT(*), MIN(\"startedAt\") FROM execution_entity;"
md5sum dashboard.sqlite backup.sqlite                    # after a cold copy, these must match
```

### Offline maintenance

`src/scripts/optimizeReplica.js` performs schema and data maintenance the running app does not: cleaning orphaned rows, marking stuck executions as crashed, `ANALYZE`, and `VACUUM`. It reports without changing anything unless you pass `--apply`, and it needs roughly twice the database size in free disk for the `VACUUM` step.

```bash
# with the app stopped
node src/scripts/optimizeReplica.js            # dry run
node src/scripts/optimizeReplica.js --apply
```

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

**Legal disclaimer:** This project is an independent, community-made tool and is **not** affiliated with, endorsed by, or sponsored by n8n.io.
