/**
 * Unit tests for the pure logic: input validation, the logger, and the error
 * classifier.
 *
 * node:test, no framework. The runner is in the Node the app already requires,
 * so there is nothing to install, nothing to keep up to date, and no second
 * config file describing how to run tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { parseIsoDate, parseDateRange, validateSetting, validateRoiEntry } =
    require(path.join(ROOT, 'src/utils/validate'));

// ---------------------------------------------------------------- parseIsoDate
test('parseIsoDate accepts a real ISO timestamp', () => {
    const d = parseIsoDate('2026-08-18T10:30:00.000Z');
    assert.equal(d.toISOString(), '2026-08-18T10:30:00.000Z');
});

test('parseIsoDate returns null instead of throwing', () => {
    // The reason this helper exists: new Date('foo').toISOString() throws a
    // RangeError, so ?startDate=foo used to be a 500 and a stack trace.
    for (const bad of ['foo', '', null, undefined, {}, [], '2026-13-45']) {
        assert.equal(parseIsoDate(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
});

test('parseIsoDate rejects years outside 2000-2100', () => {
    // '202-01-01' parses as the year 202 and silently matches nothing.
    assert.equal(parseIsoDate('0202-01-01T00:00:00Z'), null);
    assert.equal(parseIsoDate('3000-01-01T00:00:00Z'), null);
    assert.notEqual(parseIsoDate('2026-01-01T00:00:00Z'), null);
});

// --------------------------------------------------------------- parseDateRange
test('parseDateRange requires both bounds or neither', () => {
    assert.equal(parseDateRange(undefined, undefined).ok, true, 'neither is the default range');
    assert.equal(parseDateRange('2026-01-01', undefined).ok, false, 'one bound is a mistake, not a default');
    assert.equal(parseDateRange(undefined, '2026-01-01').ok, false);
});

test('parseDateRange rejects a backwards range', () => {
    // Not a database error — it simply matches nothing, which reads as
    // "no data" rather than "you asked backwards".
    const r = parseDateRange('2026-08-20T00:00:00Z', '2026-08-10T00:00:00Z');
    assert.equal(r.ok, false);
    assert.match(r.error, /before/i);
});

test('parseDateRange accepts a valid range', () => {
    const r = parseDateRange('2026-08-10T00:00:00Z', '2026-08-20T00:00:00Z');
    assert.equal(r.ok, true);
    assert.ok(r.start < r.end);
});

// -------------------------------------------------------------- validateSetting
test('validateSetting allows only known keys and says which', () => {
    const r = validateSetting('arbitrary_key', 'x');
    assert.equal(r.ok, false);
    assert.match(r.error, /timezone/, 'the error should name what IS allowed');
});

test('validateSetting checks the timezone against Intl, not a list', () => {
    assert.equal(validateSetting('timezone', 'Europe/Athens').ok, true);
    assert.equal(validateSetting('timezone', 'UTC').ok, true);
    assert.equal(validateSetting('timezone', 'Mars/Olympus_Mons').ok, false);
    assert.equal(validateSetting('timezone', '').ok, false);
});

// ------------------------------------------------------------- validateRoiEntry
test('validateRoiEntry bounds the numbers', () => {
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 50 }).ok, true);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: -1, hourly_rate: 50 }).ok, false);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 86401, hourly_rate: 50 }).ok, false);
    assert.equal(validateRoiEntry({ workflow_id: 'w1', saved_time_seconds: 60, hourly_rate: 100001 }).ok, false);
    assert.equal(validateRoiEntry({ saved_time_seconds: 60, hourly_rate: 50 }).ok, false, 'workflow_id is required');
});

// ---------------------------------------------------------------------- logger
test('the logger never prints a secret', () => {
    // Both of these had already leaked through another channel and had to be
    // rotated; the log must not be a third way out.
    const { logger } = require(path.join(ROOT, 'src/utils/logger'));
    const captured = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        logger('TEST').info('boot', {
            password: 'hunter2',
            token: 'eyJhbGciOi',
            nested: { apiKey: 'sk-live-secret', keep: 'visible' }
        });
    } finally {
        process.stdout.write = realWrite;
    }
    const out = captured.join('');
    assert.ok(!out.includes('hunter2'), 'password leaked');
    assert.ok(!out.includes('eyJhbGciOi'), 'token leaked');
    assert.ok(!out.includes('sk-live-secret'), 'nested key leaked');
    assert.ok(out.includes('visible'), 'redaction should not eat ordinary fields');
});

test('the logger keeps an Error usable', () => {
    // An Error has no enumerable properties, so a logger that treated trailing
    // arguments as a fields object would drop the message entirely.
    const { logger } = require(path.join(ROOT, 'src/utils/logger'));
    const captured = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    try {
        logger('TEST').error('Sync failed:', new Error('connection refused'));
    } finally {
        process.stderr.write = realWrite;
    }
    assert.match(captured.join(''), /connection refused/);
});

// ----------------------------------------------------------------- error parser
test('the error classifier suite passes', () => {
    // Kept as its own script rather than rewritten here: it is 47 cases built
    // from real production rows, and it doubles as a tool that can be run
    // directly while tuning the rules. Re-expressing it would fork the fixtures.
    const out = execFileSync(process.execPath, ['src/scripts/testErrorParser.js'],
        { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /0 failed/);
});
