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

n8n 2.x does ship insights tables in self-hosted installs — `insights_by_period`, `insights_raw` and `insights_metadata` are populated on a plain self-hosted instance (16,758 rows on the one this was built against). What your **license tier** decides is how much of that surfaces in the editor UI; the data is there either way. Separately, n8n prunes execution rows aggressively by default. This dashboard fills both gaps:

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
>
> Running more than one instance is *not* a hard requirement to avoid — the app elects a single ETL writer on its own. See [Running more than one instance](#-running-more-than-one-instance).

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
> Three consequences:
> - Treat `dashboard.sqlite` with the same care as your n8n database.
> - The AI Assistant executes any read-only SQL it generates against the replica, so it *can* reach these columns. A table and column allowlist is planned; until it lands, the assistant is restricted to n8n owners and admins — the roles that can already read every workflow in n8n.
> - `input_data` is cleared from rows older than 30 days by default, because nothing in the dashboard reads it. `error_stack` is kept, because the classifier re-derives from it. Both are configurable — see [Operating it](#-operating-it).

### Guarantees that do hold

- **Read-only against n8n.** No `INSERT`/`UPDATE`/`DELETE` path to your n8n database exists anywhere in the code.
- **No SQL mutation locally.** The AI pipeline rejects anything that is not a `SELECT`/`WITH`, and blocks DML/DDL keywords.
- **Air-gapped from production.** AI-generated SQL runs against the local SQLite file. Even a malicious query has no route to your Postgres server.
- **Helmet + strict CSP.** `script-src-attr 'none'`, no `unsafe-inline`, no external `connect-src`. Rendered markdown passes through DOMPurify with a restricted tag allowlist.
- **Scoped reads.** Every analytics query is narrowed to the workflows the caller's n8n projects own, including the endpoints addressed by id — an execution outside your projects answers 404, the same as one that does not exist.
- **No secrets in logs.** The logger redacts credential-shaped keys at any depth before writing.

---

## 🔐 Authentication

The dashboard has no user management of its own — it authenticates directly against your n8n user base.

- **Same credentials.** Log in with the exact email and password you use for n8n.
- **Bcrypt matching.** Your input is compared against the hash in n8n's `user` table. The raw password is never stored or logged.
- **Pass-through identity.** Change your n8n password and it takes effect here immediately.
- **Disabled and MFA-enabled accounts are rejected.** Users with `disabled = true` cannot log in. Users with MFA enabled are blocked with an explanatory message, because the dashboard cannot verify the second factor.

Sessions are JWTs signed with `DASHBOARD_JWT_SECRET`. The server refuses to boot if that secret is shorter than 32 characters.

### Who sees what

Authentication says *whether* you get in. Authorization decides *what you then see*, and it mirrors n8n's own model rather than inventing one: a workflow belongs to a project, a user belongs to a project.

| n8n role | What the dashboard shows |
|---|---|
| `global:owner`, `global:admin` | Everything. These roles can open any workflow in n8n, so scoping them here would report fewer executions than the instance actually ran — which reads as data loss, not as security. |
| Any other role | Only workflows in the projects that user belongs to. Executions, errors, ROI and volume all hang off a workflow id, so all of them narrow together. |

Two consequences worth knowing before you add a second user:

- **Instance-wide settings and forced syncs are owner/admin only.** Both change something for everybody.
- **The AI Assistant is owner/admin only for now.** It answers by running SQL it wrote itself, and a filter cannot be safely bolted onto a query a model composed — one subquery steps around it. Scoped users get an explanatory 403 rather than an answer computed over everyone's data. This lifts once the table allowlist lands.

Membership is re-mirrored on every sync, wholesale rather than incrementally. That matters: removing someone from a project in n8n is expressed by the row *disappearing*, and a sync that only ever inserts and updates could never observe a disappearance — the revoked user would keep their access here forever.

---

## 🖥️ Stack

**Backend** — Node.js + Express 5, modular MVC:

| Path | Role |
|---|---|
| `src/config/db.js` | PostgreSQL connection pool (n8n source) |
| `src/config/localDb.js` | SQLite replica: connection, pragmas, migration runner, batch helpers |
| `src/config/schema.js` | The schema as data — migrations, indexes, and which n8n columns are mirrored |
| `src/config/syncJob.js` | The ETL and the error classification engine |
| `src/config/instanceLock.js` | Single-writer election for the ETL, stored in the replica itself |
| `src/config/errorParser.js` | Error classification rules — pure, no I/O, unit-tested |
| `src/config/openai.js` | OpenAI client initialization |
| `src/controllers/` | Analytics, auth, and AI business logic |
| `src/middlewares/` | `auth.js` (JWT + scope), `rateLimiter.js`, `sqliteRateStore.js`, `requestLog.js` |
| `src/utils/scope.js` | Which workflows a user may see |
| `src/utils/validate.js` | Input validation shared by the controllers |
| `src/utils/logger.js` | Levelled, redacting, JSON-or-pretty logger |
| `src/routes/` | Endpoint → controller mapping |
| `src/scripts/optimizeReplica.js` | Offline replica maintenance (dry-run by default, `--apply` to commit) |
| `test/` | `node --test` suites — unit, plus an integration run that boots the real server |

**Frontend** — vanilla JS and the standard DOM API, no bundler and no JS build step.

Every third-party asset is served from `public/vendor/`: Chart.js, marked, DOMPurify, Font Awesome and Open Sans. Nothing is fetched from a CDN, so the dashboard renders with no external network access and no origin other than your own can supply script to a page holding an auth token. To upgrade one of them, bump it in `package.json` and re-run:

```bash
npm install
node src/scripts/vendorAssets.js   # copies node_modules → public/vendor
```

The copies are committed on purpose — the Docker build installs dependencies before the source is copied in, so they have to already be in the image.

Tailwind CSS v4 **is** compiled — run `npm run build:css` after editing `public/css/input.css` (or `npm run watch:css` while developing).

**Schema** — applied by an ordered set of migrations recorded in `schema_migrations`, each in its own transaction. They are idempotent, so an existing replica upgrades in place, and a migration that fails stops the process rather than leaving the schema in a state nobody has described. On boot the app also enables WAL journaling, sets a 5s busy timeout, and creates the indexes covering the dashboard's access patterns.

**The server does not accept connections until the migrations have finished.** A container that has not bound its port is not ready, which is exactly what an orchestrator should see.

**What is mirrored** — n8n's `execution_entity` has nineteen columns. The replica takes fourteen of them: the four this dashboard started with, plus trigger mode, creation time, wait-until, finished, the two retry columns, the JSON and binary payload sizes, and the workflow version that ran. From `workflow_entity` it also takes archived state, parent folder, created/updated, trigger count and description. Which columns are read is decided at runtime from `information_schema`, so an instance a version or two behind gets fewer columns rather than a failing ETL.

Two are left out on purpose. `deletedAt` would always be NULL here, because the fetch already filters soft-deleted rows out — a column that can only ever hold one value reads like an answer. `storedAt`, `deduplicationKey`, `tracingContext` and `usedPrivateCredentials` have no consumer; mirroring a column costs a write on every row forever, so each has to earn it.

**Catching up** — a replica that predates those columns fills them in from Postgres over the next few sync cycles, oldest first, time-boxed so no single cycle stalls. Executions n8n has already pruned keep NULLs, which is the truthful answer rather than a guess. On the 500,000-row replica this was built against, 98,000 rows still existed upstream and the whole pass took about 35 seconds; the remaining 405,000 are history only this database still has.

---

## 🤖 AI Chat Assistant

A three-step text-to-SQL pipeline:

1. **Intent → SQL.** Your question plus the replica schema go to the model, which returns SQLite.
2. **Guarded execution.** The query must be a `SELECT` or `WITH`; DML/DDL keywords are rejected. It runs against `dashboard.sqlite`.
3. **Results → prose.** The rows go back to the model for a human-readable answer.

The generated SQL is shown alongside every answer, so you can always check what was actually asked. Requires `OPENAI_API_KEY`; the rest of the dashboard works without it.

> [!IMPORTANT]
> **Available to n8n owners and admins only.** The pipeline runs SQL the model composed, over the whole replica — including the raw error columns described under [Security & data privacy](#-security--data-privacy). Restricting it to the roles that can already see every workflow in n8n is the honest position until a table and column allowlist replaces free-form SQL. Everyone else receives a 403 that says so.

---

## 🛠️ Installation

### Prerequisites

- **Node.js 20+** (the Docker image uses `node:22-alpine`; Node 18 is end-of-life and no longer receives security patches)
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
#SYNC_ID_OVERLAP=500             # ids re-read each cycle, so late commits are not missed
#EXECUTION_MISSING_GRACE_MS=3600000  # before a vanished execution is marked 'unknown'
#SAVE_DEBUG_ERRORS=true          # dumps raw JSON traces to disk for troubleshooting

# --- Multi-instance & shutdown ---
#ETL_LOCK_TTL_MS=60000           # how long an abandoned ETL lock is honoured
#SHUTDOWN_TIMEOUT_MS=8000        # must stay below your orchestrator's stop grace period

# --- Error analytics queue ---
#ERROR_BATCH_LIMIT=500           # max queue entries drained per cycle
#ERROR_CHUNK_SIZE=50             # execution ids per payload query
#MAX_ERROR_PAYLOAD_BYTES=5242880 # traces larger than this are skipped, not loaded
#MAX_ANALYTICS_ATTEMPTS=5        # retries before an execution is parked as failed

# --- Retention --- (see "Operating it": the row is always kept, only the heavy
# columns are cleared. 0 means keep forever.)
#ERROR_DETAIL_RETENTION_DAYS=30  # clears input_data; nothing in the app reads it
#ERROR_STACK_RETENTION_DAYS=0    # keep: reclassification re-derives from it

# --- Logging ---
#LOG_LEVEL=info                  # error | warn | info | debug
#LOG_FORMAT=json                 # json | pretty (default: pretty on a TTY)
#SLOW_REQUEST_MS=2000            # requests above this are logged at warn
#SYNC_RUN_HISTORY=500            # rows kept in sync_runs

# --- Limits ---
#API_RATE_LIMIT_PER_MINUTE=300   # ceiling per user across /api

# --- Postgres timeouts ---
#DASHBOARD_DB_STATEMENT_TIMEOUT_MS=60000
#DASHBOARD_DB_CONNECT_TIMEOUT_MS=15000
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

> [!WARNING]
> **Upgrading a deployment created before the container ran unprivileged.**
> The image now runs as the `node` user (uid 1000) instead of root. Docker applies the image's ownership only to a volume it creates **empty** — a volume that already exists is left exactly as it was, so one written by an older root container stays root-owned and the new container cannot open its own database. Run this once, before deploying:
>
> ```bash
> docker run --rm -v n8n_dashboard_data:/data alpine chown -R 1000:1000 /data
> ```
>
> If you forget, nothing is damaged: the app refuses to start and prints that exact command.

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

## ⚖️ Running more than one instance

The replica is a single SQLite file, and two processes running the ETL against it will corrupt it — *quietly*. During development, `PRAGMA integrity_check` returned `ok` on a file that had silently lost 86% of its rows. The damage was only visible by comparing row counts by hand.

**You do not have to configure anything to be safe from this.** The application enforces a single writer itself:

- On startup, and every few seconds after, each instance tries to claim an ETL lock stored **inside the replica**.
- Exactly one wins. That instance runs the sync.
- Every other instance serves the dashboard normally and simply never writes. `/api/health/deep` reports `etl.role` as `writer` or `reader`, so you can always tell which is which.
- If the writer stops cleanly, it hands the lock back and a replacement picks it up immediately. If it is killed outright, the lock expires after `ETL_LOCK_TTL_MS` (default 60s) and another instance takes over on its own.

The lock lives in the database file rather than in a lock file or your orchestrator's config, which means it has the correct scope everywhere with nothing to set up: Docker Swarm, Portainer, plain `docker run`, Kubernetes, systemd, or two terminals on a laptop. Processes that can corrupt each other are exactly the processes that share the file — and therefore exactly the processes that can see each other's lock.

A useful consequence: if you want several instances behind a load balancer for read throughput, that already works. One syncs, the rest serve.

### Platform settings (optional)

These no longer prevent corruption — the lock does. They only shorten the window in which a second instance is up and the data is briefly not being refreshed.

- Keep the service at **1 replica** unless you specifically want read scaling.
- On **Docker Swarm** (used under the hood by Easypanel and several PaaS providers), prefer `stop-first` so the old task is gone before the new one starts:
  ```bash
  docker service update --update-order stop-first <service>
  ```
- On Swarm, stop and start with `docker service scale <service>=0` / `=1`. `docker stop`/`docker start` leaves an orphan container that Swarm does not manage.

> [!NOTE]
> The lock only governs the ETL. Several instances may hold the file open and make small writes (settings, chat history); WAL journaling and `busy_timeout` handle that. It is bulk concurrent writing that destroys the file, and that is what is prevented.

---

## 🧰 Operating it

### Logs

Levelled and structured. `LOG_LEVEL` is `error | warn | info | debug` (default `info`), and the format defaults to human-readable on a terminal and JSON everywhere else, so a developer and a log shipper each get what they need without configuring anything.

```
INFO  [SYNC] Synced 163 workflows.
INFO  [HTTP] GET /api/analytics/metrics 200 id=8f2a1c04 method=GET status=200 ms=41 user=…
```

Every `/api/*` response carries an `X-Request-Id`, echoed from the caller's own header when it sends one. Paste it into a log search to get that request and everything it caused. Values for keys that look like credentials — `password`, `token`, `authorization`, `apiKey`, `*_secret` — are replaced with `[redacted]` before anything is written, at any nesting depth.

### Sync history

Every ETL pass writes a row to `sync_runs`: duration, rows read, executions changed, errors extracted, retention effects, and the size of the replica. The last 500 are kept. It is the quickest answer to "when did this last succeed" and "is it getting slower":

```sql
SELECT started_at, status, duration_ms, executions, replica_bytes/1048576 AS mb
FROM sync_runs ORDER BY id DESC LIMIT 20;
```

### Rate limits

| What | Limit | Keyed on |
|---|---|---|
| Failed logins, one account | 10 / 15 min | source address + email |
| Failed logins, one source | 30 / 15 min | source address |
| AI chat | 5 / min | user |
| Forced sync | 2 / min | user |
| Everything else under `/api` | 300 / min (`API_RATE_LIMIT_PER_MINUTE`) | user, falling back to address |

The login, AI and sync counters live in the replica, so a restart, a rolling deploy or a second instance does not hand a caller a fresh allowance. The per-account login limit includes the source address deliberately: keyed on the email alone, anyone who knows your address could lock you out of your own dashboard by failing ten logins.

### Retention

The error analytics row is never deleted — every count, category and chart keeps working. Only the raw evidence behind old rows is cleared, and the two heavy columns are governed separately because they are not the same kind of data:

- `input_data` is the payload that entered the failing node. Nothing in the dashboard reads it, so it is cleared after `ERROR_DETAIL_RETENTION_DAYS` (default 30).
- `error_stack` is kept forever by default. When the classifier's rules improve, the message and category of every stored error are re-derived **from it**; clearing it means those rows can never be corrected. Set `ERROR_STACK_RETENTION_DAYS` only if you have decided that trade is worth the disk.

Clearing a column frees pages for reuse, so the file stops growing — it does not shrink. To reclaim the space, run `node src/scripts/optimizeReplica.js --apply` with the app stopped.

### Tests and linting

```bash
npm run lint     # eslint
npm test         # node --test: unit + integration
npm run check    # both, the same gate CI applies before deploying
```

The integration suite boots the real server against a temporary SQLite file and calls every endpoint. It needs no PostgreSQL and no n8n instance, deliberately — a test that cannot run in CI does not run at all. Pushing to `main` runs lint and tests first; the deploy webhook is only called if they pass.

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
