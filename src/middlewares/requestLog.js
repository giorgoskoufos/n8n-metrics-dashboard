/**
 * One line per API request, with an id that ties it to everything it caused.
 *
 * There was no request logging at all. A 500 in the container log was a stack
 * trace with nothing around it: no path, no user, no duration, and no way to
 * tell whether the three lines above it came from the same request or three
 * different ones arriving at once.
 *
 * The id is taken from an incoming X-Request-Id when there is one, so a proxy or
 * a caller that already assigns ids keeps its own thread through the logs, and
 * generated otherwise. It goes back out on the response, which is what lets
 * someone paste the id from a failed request straight into a log search.
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const log = logger('HTTP');

// A client-supplied id is echoed into every log line, so it cannot be allowed to
// carry newlines or hundreds of characters of someone else's choosing.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Requests slower than this are logged at warn even when they succeeded. */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 2000;

function requestLog(req, res, next) {
    const supplied = req.get('x-request-id');
    const id = supplied && SAFE_ID.test(supplied) ? supplied : crypto.randomUUID().slice(0, 8);

    req.id = id;
    res.setHeader('X-Request-Id', id);

    const startedAt = process.hrtime.bigint();

    // 'finish' fires when the response has been handed to the socket; 'close'
    // catches the client that hung up first, which is otherwise invisible and is
    // exactly the case worth seeing when something is slow.
    let done = false;
    const record = (aborted) => {
        if (done) return;
        done = true;

        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const fields = {
            id,
            method: req.method,
            // The route pattern, not the filled-in path, so drilldowns of a
            // thousand different workflows aggregate into one line in a log
            // search instead of a thousand.
            path: (req.route && req.baseUrl + req.route.path) || req.originalUrl.split('?')[0],
            status: res.statusCode,
            ms: Math.round(ms),
            user: (req.user && req.user.id) || undefined
        };
        if (aborted) fields.aborted = true;

        const level = res.statusCode >= 500 || aborted ? 'error'
            : res.statusCode >= 400 ? 'warn'
            : ms >= SLOW_MS ? 'warn'
            : 'info';

        log[level](`${req.method} ${fields.path} ${res.statusCode}`, fields);
    };

    res.on('finish', () => record(false));
    res.on('close', () => record(!res.writableEnded));

    next();
}

module.exports = { requestLog };
