/**
 * The application logger.
 *
 * Before this, everything went through console.log. Three consequences, all of
 * which showed up while debugging this codebase:
 *
 *   - No levels. There was no way to turn detail up while chasing a problem or
 *     down to stop a five-minute cron filling the container log, so the ETL
 *     printed the same eight lines forever and the interesting ones were lost
 *     among them.
 *   - Nothing machine-readable. `docker logs | grep` is the only tool that works
 *     on prose, and prose changes.
 *   - No way to connect lines. A 500 in the log had no thread back to the
 *     request that caused it, the user who sent it, or how long it took.
 *
 * Written here rather than pulling in pino. pino is a good library, but it
 * brings worker-thread transports and a plugin surface to a program that emits a
 * few dozen lines a minute — and this project has already taken the position
 * that a dependency has to earn its place (see vendorAssets.js). The whole
 * implementation is below and does exactly what the app needs.
 *
 * Format:
 *   LOG_FORMAT=json   one JSON object per line, for anything that ships logs
 *   LOG_FORMAT=pretty aligned and human-readable
 *   unset             pretty when stdout is a terminal, json otherwise — so a
 *                     developer gets readable output and a container gets
 *                     parseable output, without either having to configure it.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configuredLevel] !== undefined ? LEVELS[configuredLevel] : LEVELS.info;

const format = (process.env.LOG_FORMAT || '').toLowerCase() ||
    (process.stdout.isTTY ? 'pretty' : 'json');

/**
 * Keys whose values never reach the log, whatever they contain.
 *
 * A denial rather than a promise to be careful: the fields below have all been
 * within one console.log of the log at some point in this codebase — the JWT is
 * in every request header, the Postgres password is in the connection config,
 * and the OpenAI key is on the client object. Two of the three had already
 * leaked through a different channel and had to be rotated.
 */
const REDACTED_KEYS = /^(password|passwd|pass|token|authorization|auth|secret|apikey|api_key|jwt|cookie|set-cookie|dashboard_db_pass|openai_api_key|dashboard_jwt_secret)$/i;

function redact(value, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > 4) return value;
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = REDACTED_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
}

// ANSI only when the output is a terminal; a log file full of escape codes is
// worse than no colour at all.
const COLOURS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

/**
 * Turns a console-style argument list into a message plus fields.
 *
 * Deliberately permissive, because every call site in this codebase was written
 * against console.log and passes whatever it had: a trailing Error, a stray
 * number, an object. A logger that quietly dropped those extras would erase the
 * detail that makes the line worth logging — an Error object in particular has
 * no enumerable properties, so treating it as a fields object loses the message
 * and the stack together.
 */
function normalise(message, rest) {
    let text = String(message);
    const fields = {};

    for (const arg of rest) {
        if (arg instanceof Error) {
            fields.err = arg.message;
            if (arg.code) fields.code = arg.code;
            if (threshold >= LEVELS.debug && arg.stack) fields.stack = arg.stack;
        } else if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
            Object.assign(fields, arg);
        } else if (arg !== undefined) {
            text += ' ' + (typeof arg === 'string' ? arg : fmt(arg));
        }
    }
    return { text, fields };
}

function emit(level, component, message, fields) {
    if (LEVELS[level] > threshold) return;

    const entry = {
        time: new Date().toISOString(),
        level,
        component,
        message: String(message),
        ...redact(fields || {})
    };

    const line = format === 'json'
        ? JSON.stringify(entry)
        : `${process.stdout.isTTY ? COLOURS[level] : ''}${level.toUpperCase().padEnd(5)}${process.stdout.isTTY ? RESET : ''} ` +
          `[${component}] ${entry.message}` +
          (fields && Object.keys(fields).length
              ? ' ' + Object.entries(redact(fields)).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')
              : '');

    // stderr for problems, stdout for everything else — so `2>` separates them
    // and an orchestrator's error stream means something.
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

function fmt(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return /\s/.test(s) ? JSON.stringify(s) : s;
}

/**
 * A logger bound to one component, so every line it writes is attributable
 * without the caller repeating the name.
 *
 *   const log = logger('SYNC');
 *   log.info('Synced workflows', { count: 163 });
 */
function logger(component) {
    const at = (level) => (message, ...rest) => {
        if (LEVELS[level] > threshold) return;   // skip normalise() entirely when filtered out
        const { text, fields } = normalise(message, rest);
        emit(level, component, text, fields);
    };
    return {
        error: at('error'),
        warn: at('warn'),
        info: at('info'),
        debug: at('debug'),
        /** For a sub-area of the same component, e.g. logger('SYNC').child('ANALYTICS'). */
        child: (sub) => logger(`${component}:${sub}`)
    };
}

module.exports = { logger, LEVELS, level: configuredLevel, format };
