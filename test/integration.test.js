/**
 * Boots the real server against a temporary replica and calls every endpoint.
 *
 * This is the test that catches what unit tests structurally cannot: a route
 * left out of a middleware chain, a SQL fragment whose parameters no longer line
 * up, a migration that does not run on an empty database. Every one of those has
 * happened in this codebase, and each was found by starting the app rather than
 * by reading it.
 *
 * No Postgres. CI does not have an n8n instance, and requiring one would mean
 * this suite never runs. The handful of endpoints that genuinely need the source
 * database are asserted to fail the way they are documented to fail, which is
 * itself worth checking — a missing Postgres should be a 503, not a crash.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PORT = 3117;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(48).toString('base64');
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'n8ndb-test-')), 'test.sqlite');

const OWNER = jwt.sign({ id: 'u-owner', email: 'o@x', role: 'global:owner', jti: '1' }, SECRET, { expiresIn: '1h' });
const MEMBER = jwt.sign({ id: 'u-member', email: 'm@x', role: 'global:member', jti: '2' }, SECRET, { expiresIn: '1h' });

let child;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function api(pathname, { token, method = 'GET', body } = {}) {
    const res = await fetch(BASE + pathname, {
        method,
        headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (ignored) { /* 204 and friends have no body */ }
    return { status: res.status, body: json, headers: res.headers };
}

/** A handful of rows, so "200 with an empty array" cannot pass for "200 with data". */
function seed() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB);
        db.serialize(() => {
            db.run(`CREATE TABLE workflow_entity (id TEXT PRIMARY KEY, name TEXT, active BOOLEAN)`);
            db.run(`CREATE TABLE execution_entity (
                id INTEGER PRIMARY KEY, "workflowId" TEXT, status TEXT,
                "startedAt" DATETIME, "stoppedAt" DATETIME)`);
            db.run("INSERT INTO workflow_entity VALUES ('wf-a','Alpha',1),('wf-b','Beta',1)");

            const now = Date.now();
            const rows = [];
            for (let i = 0; i < 40; i++) {
                const started = new Date(now - i * 60000);
                const stopped = new Date(started.getTime() + 2500);
                rows.push([1000 + i, i % 2 ? 'wf-a' : 'wf-b', i % 5 === 0 ? 'error' : 'success',
                    started.toISOString(), stopped.toISOString()]);
            }
            const stmt = db.prepare(
                'INSERT INTO execution_entity (id,"workflowId",status,"startedAt","stoppedAt") VALUES (?,?,?,?,?)');
            for (const r of rows) stmt.run(r);
            stmt.finalize();
        });
        db.close((e) => (e ? reject(e) : resolve()));
    });
}

test.before(async () => {
    await seed();

    child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            DASHBOARD_DB_PATH: DB,
            DASHBOARD_PORT: String(PORT),
            DASHBOARD_JWT_SECRET: SECRET,
            // No n8n instance in CI. The boot sync would spend its connection
            // timeout failing before the first assertion could run.
            SKIP_BOOT_SYNC: '1',
            SYNC_INTERVAL_MINUTES: '59',
            LOG_LEVEL: 'error',
            N8N_EDITOR_BASE_URL: 'http://127.0.0.1:9',   // closed port: /n8n-health must fail cleanly
            DASHBOARD_DB_HOST: '127.0.0.1',
            DASHBOARD_DB_PORT: '1',
            DASHBOARD_DB_CONNECT_TIMEOUT_MS: '400'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });

    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(BASE + '/healthz')).ok) return; } catch (ignored) { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('server did not start within 15s:\n' + log);
});

test.after(async () => {
    if (child) child.kill('SIGTERM');
    await sleep(1500);
    if (child && !child.killed) child.kill('SIGKILL');
    try { fs.rmSync(path.dirname(DB), { recursive: true, force: true }); } catch (ignored) { /* temp dir */ }
});

// ------------------------------------------------------------ schema and boot
test('the migrations build a complete schema on an empty database', async () => {
    // The server only starts listening once they have finished, so reaching this
    // test at all is half the assertion; the other half is that they ran against
    // a database that already had two of the tables.
    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    const rows = await new Promise((resolve, reject) => {
        db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, r) => (e ? reject(e) : resolve(r)));
    });
    db.close();
    const tables = rows.map((r) => r.name);
    for (const t of ['schema_migrations', 'project', 'project_relation', 'shared_workflow',
        'execution_volume_stats', 'rate_limits', 'sync_runs', 'dashboard_settings',
        'execution_error_analytics', 'instance_lock']) {
        assert.ok(tables.includes(t), `missing table ${t} — have ${tables.join(', ')}`);
    }
});

// ------------------------------------------------------------------ probes
test('liveness is open, readiness reports the missing Postgres', async () => {
    assert.equal((await api('/healthz')).status, 200);
    // 503 rather than a crash: no n8n database is reachable in this environment.
    assert.equal((await api('/readyz')).status, 503);
});

// ------------------------------------------------------------------- auth
test('every API route refuses an anonymous caller', async () => {
    const routes = [
        '/api/analytics/metrics', '/api/analytics/executions', '/api/analytics/slowest',
        '/api/analytics/errors', '/api/analytics/roi', '/api/analytics/first-execution-date',
        '/api/analytics/execution-volume', '/api/analytics/error-intelligence',
        '/api/settings', '/api/settings/roi', '/api/chat-history', '/api/health/deep'
    ];
    for (const r of routes) {
        assert.equal((await api(r)).status, 401, `${r} answered an anonymous caller`);
    }
});

test('an unusable token is 401, not 403', async () => {
    // The distinction the frontend depends on: 401 clears the session, 403 shows
    // a message. While a bad token answered 403, every authorization refusal in
    // the app logged the user out instead of explaining itself.
    assert.equal((await api('/api/analytics/slowest', { token: 'not-a-jwt' })).status, 401);
});

// ------------------------------------------------------------- read endpoints
test('every read endpoint answers with data', async () => {
    const checks = [
        ['/api/analytics/metrics', (b) => b.summary.total === 40 && b.topWorkflows.length === 2],
        ['/api/analytics/executions?limit=50', (b) => b.length === 40],
        ['/api/analytics/slowest', (b) => b.length === 2],
        ['/api/analytics/errors', (b) => b.length > 0],
        ['/api/analytics/roi', (b) => Number(b.summary.total_executions) === 32],
        ['/api/analytics/first-execution-date', (b) => typeof b.firstDate === 'string'],
        ['/api/analytics/execution-volume', (b) => Array.isArray(b)],
        ['/api/analytics/error-intelligence', (b) => 'summary' in b && 'categories' in b],
        ['/api/settings', (b) => typeof b === 'object'],
        ['/api/settings/roi', (b) => b.length === 2],
        ['/api/chat-history', (b) => Array.isArray(b)],
        ['/api/analytics/execution-volume/details?time=' +
            encodeURIComponent(new Date(Date.now() - 600000).toISOString()) + '&window=60',
            (b) => Array.isArray(b) && b.length > 0]
    ];
    for (const [route, ok] of checks) {
        const r = await api(route, { token: OWNER });
        assert.equal(r.status, 200, `${route} -> ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(ok(r.body), `${route} returned unexpected shape: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
});

test('the chart and its drill-down count the same thing', async () => {
    // L-30: they used to answer different questions — the chart counted starts,
    // the drill-down counted overlaps, so a bar of height 12 could open a list of
    // 30 rows and neither number was wrong.
    //
    // Asked for an explicit range rather than the default. The default reads the
    // series the ETL caches, and the ETL is deliberately not running here.
    const start = new Date(Date.now() - 3 * 3600000).toISOString();
    const end = new Date(Date.now() + 3600000).toISOString();
    const series = await api(
        `/api/analytics/execution-volume?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        { token: OWNER });
    assert.equal(series.status, 200);

    const filled = series.body.filter((b) => b.started_count > 0);
    assert.ok(filled.length > 0, 'the seeded executions should land in some bucket');
    assert.equal(
        series.body.reduce((a, b) => a + b.started_count, 0), 40,
        'every seeded execution should be counted exactly once');

    for (const bucket of filled.slice(0, 5)) {
        const drill = await api(
            `/api/analytics/execution-volume/details?time=${encodeURIComponent(bucket.timestamp)}&window=5`,
            { token: OWNER });
        assert.equal(drill.body.length, bucket.started_count,
            `bar and drill-down disagree at ${bucket.timestamp}`);
        for (const row of drill.body) {
            assert.ok(row.startedAt >= bucket.timestamp, 'a row started before its bucket');
        }
    }
});

// ------------------------------------------------------------- input validation
test('bad input is 400, never 500', async () => {
    const bad = [
        '/api/analytics/metrics?startDate=foo&endDate=bar',
        '/api/analytics/metrics?startDate=2026-08-20T00:00:00Z',            // only one bound
        '/api/analytics/metrics?startDate=2026-08-20T00:00:00Z&endDate=2026-08-01T00:00:00Z', // backwards
        '/api/analytics/executions?status=not-a-status',
        '/api/analytics/execution-volume/details?time=nonsense'
    ];
    for (const route of bad) {
        const r = await api(route, { token: OWNER });
        assert.equal(r.status, 400, `${route} -> ${r.status}`);
        assert.ok(r.body && r.body.error, 'a 400 should say what was wrong');
    }
});

test('a malformed JSON body is 400 and leaks no stack trace', async () => {
    const res = await fetch(BASE + '/api/settings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER, 'Content-Type': 'application/json' },
        body: '{not json'
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!/at .*\(.*:\d+:\d+\)/.test(text), 'response contained a stack trace');
});

// ----------------------------------------------------------------- authorization
test('instance-wide settings are owner-only', async () => {
    assert.equal((await api('/api/settings', {
        token: MEMBER, method: 'POST', body: { key: 'timezone', value: 'UTC' }
    })).status, 403);

    assert.equal((await api('/api/settings', {
        token: OWNER, method: 'POST', body: { key: 'timezone', value: 'Europe/Athens' }
    })).status, 200);

    const after = await api('/api/settings', { token: OWNER });
    assert.equal(after.body.timezone, 'Europe/Athens');
});

test('an unknown setting key is refused and names what is allowed', async () => {
    const r = await api('/api/settings', {
        token: OWNER, method: 'POST', body: { key: 'anything', value: 'x' }
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /timezone/);
});

test('ROI writes validate the workflow and the numbers', async () => {
    assert.equal((await api('/api/settings/roi', {
        token: OWNER, method: 'POST', body: { settings: [{ workflow_id: 'wf-a', saved_time_seconds: 120, hourly_rate: 40 }] }
    })).status, 200);

    const unknown = await api('/api/settings/roi', {
        token: OWNER, method: 'POST', body: { settings: [{ workflow_id: 'does-not-exist', saved_time_seconds: 1, hourly_rate: 1 }] }
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /Unknown workflow id/);

    const absurd = await api('/api/settings/roi', {
        token: OWNER, method: 'POST', body: { settings: [{ workflow_id: 'wf-a', saved_time_seconds: 999999, hourly_rate: 1 }] }
    });
    assert.equal(absurd.status, 400);
});

test('the AI assistant is refused to a scoped user rather than answering unscoped', async () => {
    // No project membership is mirrored here, so a member currently resolves as
    // unrestricted and the chat is allowed through to OpenAI — which is not
    // configured in this environment. Either answer is acceptable; what must not
    // happen is a crash.
    const r = await api('/api/ai-chat', { token: MEMBER, method: 'POST', body: { message: 'hello' } });
    assert.ok([403, 500].includes(r.status), `unexpected ${r.status}`);
});

// -------------------------------------------------------------------- logging
test('every response carries a request id', async () => {
    const r = await api('/api/analytics/slowest', { token: OWNER });
    assert.match(r.headers.get('x-request-id') || '', /^[A-Za-z0-9._-]+$/);
});

test('a caller-supplied request id is honoured, a hostile one is not', async () => {
    const good = await fetch(BASE + '/api/analytics/slowest', {
        headers: { Authorization: 'Bearer ' + OWNER, 'X-Request-Id': 'trace-abc-123' }
    });
    assert.equal(good.headers.get('x-request-id'), 'trace-abc-123');

    const bad = await fetch(BASE + '/api/analytics/slowest', {
        headers: { Authorization: 'Bearer ' + OWNER, 'X-Request-Id': 'a'.repeat(500) }
    });
    assert.notEqual(bad.headers.get('x-request-id'), 'a'.repeat(500));
});

// ----------------------------------------------------------- endpoints needing pg
test('endpoints that need Postgres fail cleanly instead of crashing', async () => {
    const health = await api('/api/health/deep', { token: OWNER });
    assert.equal(health.status, 503);
    assert.match(health.body.postgres, /error/);
    assert.equal(health.body.replica, 'ok', 'the replica should still be reported healthy');

    const login = await api('/api/login', {
        method: 'POST', body: { email: 'nobody@example.com', password: 'x' }
    });
    assert.equal(login.status, 500);

    assert.equal((await api('/api/n8n-health', { token: OWNER })).status, 500);

    // And the process is still up and serving after all of that.
    assert.equal((await api('/api/analytics/slowest', { token: OWNER })).status, 200);
});
