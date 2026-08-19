// Pure error-trace parsing and classification. No I/O, no database handles, no
// side effects on require — the backfill script depends on that, so it can reuse
// this logic without opening Postgres or the replica.

/**
 * Bump this whenever the parsing or classification rules change in a way that
 * would give a different answer for the same input.
 *
 * Rows already in the replica were classified by whatever rules were current when
 * they were written, and nothing revisits them: a rule improvement silently
 * applies to new errors only, leaving the history disagreeing with the present.
 * The sync compares this against what is stored and re-classifies once when they
 * differ — which is the right shape for this work. A cron would rescan the table
 * forever to do nothing, and asking people to remember a script means the history
 * quietly stays wrong.
 *
 *   1 — original heuristics
 *   2 — stack reconciliation (H-32), httpCode first, narrowed data rules,
 *       qualified 'token', 'service ... unavailable', process-launch as config,
 *       Code-node tiebreak only (M-33)
 */
const CLASSIFIER_VERSION = 2;

/**
 * Pulls the HTTP status out of an n8n error object.
 *
 * This is worth doing because it is *evidence* rather than inference. Matching
 * "429" against free text catches an order id that happens to contain 429 and
 * misses a rate limit whose message never mentions a number. n8n puts the real
 * status on the error in several places depending on the node and version.
 */
function extractHttpCode(err) {
    if (!err || typeof err !== 'object') return null;
    const candidates = [
        err.httpCode, err.statusCode, err.status,
        err.context && err.context.httpCode,
        err.cause && (err.cause.httpCode || err.cause.statusCode || err.cause.status),
        err.response && (err.response.status || err.response.statusCode)
    ];
    for (const c of candidates) {
        const n = typeof c === 'string' ? parseInt(c, 10) : c;
        // Anything outside the HTTP range is some other kind of code entirely.
        if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
    }
    return null;
}

// Patterns that genuinely indicate a data or shape problem. The previous version
// matched the bare words 'null', 'undefined', 'missing', 'invalid' and 'expected'
// anywhere in the message, which swallowed almost everything — 6.723 of 14.203
// rows landed in 'data', including plain API failures whose body merely mentioned
// a null field.
const DATA_PATTERNS = [
    /cannot read propert/i,
    /is not a function/i,
    /is not iterable/i,
    /unexpected token/i,
    /json.*(parse|unexpected)/i,
    /parse error/i,
    /validation (failed|error)/i,
    /invalid (json|format|input|value|type|date|argument|url|uri|email)/i,
    /expected .* (but|to be)/i,
    // Node's own wording for a type mismatch: "The first argument must be of type
    // string…". 1.400 rows read as generic node failures without this.
    /must (be of type|start with|be an? )/i,
    /of undefined|of null/i,
    /required (property|field|parameter)/i,
    // Postgres rejecting a row the workflow built.
    /failing row contains/i,
    /no rows matching the provided values/i
];

/**
 * Classifies an error into an actionable category.
 *
 * Order matters — the strongest evidence is consulted first. httpCode beats text
 * matching; explicit error types beat keyword guesses; node type is the tiebreak
 * when nothing else decides.
 */
function classifyError(errorMessage, errorType, nodeType, httpCode = null) {
    const msg = (errorMessage || '').toLowerCase();
    const type = (errorType || '').toLowerCase();
    const node = (nodeType || '').toLowerCase();

    // 0. The HTTP status, when we have one. This is a fact about the response
    //    rather than a guess about the wording, so it outranks everything else.
    if (Number.isInteger(httpCode)) {
        if (httpCode === 429) return 'rate_limit';
        if (httpCode === 401 || httpCode === 403) return 'auth';
        if (httpCode >= 500) return 'upstream';
        if (httpCode === 408) return 'network';
        // 4xx other than the above is the request being wrong — our data.
        if (httpCode >= 400) return 'data';
    }

    // 1. Rate Limited (very specific, highest priority)
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') ||
        msg.includes('quota exceeded') || msg.includes('throttl')) {
        return 'rate_limit';
    }

    // 2. Auth / Credentials
    //
    // 'token' used to be matched on its own, which made every "Unexpected token
    // < in JSON" a credentials problem. The word only means authentication when
    // it is qualified, so it now has to be.
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('forbidden') ||
        msg.includes('403') || msg.includes('credential') ||
        // Stem, not the whole word: "Not authenticated" was reaching the node
        // tiebreak and coming out as a network problem.
        msg.includes('authenticat') || msg.includes('permission denied') ||
        msg.includes('access denied') || msg.includes('oauth') || msg.includes('api key') ||
        /\b(access|bearer|refresh|auth|api)[ _-]?token\b/.test(msg) ||
        /\btoken (has )?(expired|is invalid|is missing|was revoked|not provided)\b/.test(msg) ||
        /\b(invalid|expired|missing|revoked) token\b/.test(msg)) {
        return 'auth';
    }

    // 3. Network / Timeout
    if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound') ||
        msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('esockettimedout') ||
        msg.includes('dns') || msg.includes('socket hang up') || msg.includes('network') ||
        msg.includes('cannot be established') || msg.includes('getaddrinfo') ||
        msg.includes('connect econnrefused') ||
        // n8n's own phrasing for an unreachable endpoint.
        msg.includes('refused the connection') || msg.includes('perhaps it is offline') ||
        msg.includes('closed unexpectedly')) {
        return 'network';
    }

    // 4. Upstream Server Errors (5xx)
    //
    // The literal 'service unavailable' missed n8n's own wording, "The service
    // is currently unavailable" — 108 rows in the replica sat in 'unknown'
    // because of the two words in between.
    // A bare 'temporarily unavailable' was tried here and had to be removed: it
    // matched "Resource temporarily unavailable", the OS EAGAIN text that appears
    // in embedded chromium stderr, and reclassified 1.316 local browser-launch
    // failures as upstream outages. The word only means an upstream problem when
    // it is a service that is unavailable.
    if (/\b50[0-4]\b/.test(msg) || msg.includes('internal server error') ||
        msg.includes('bad gateway') || msg.includes('gateway timeout') ||
        /\bservice\b.{0,20}\bunavailable\b/.test(msg)) {
        return 'upstream';
    }

    // 5. Configuration / Workflow Issues
    if (type === 'workflowhasissueserror' || msg.includes('not configured') ||
        msg.includes('suspended') || msg.includes('disabled') || msg.includes('not set up') ||
        msg.includes('is not valid') || msg.includes('no value set') ||
        msg.includes('parameter') && msg.includes('required') ||
        // A process that will not start is an environment problem, not a data
        // one. 1.309 chromium launch failures were sitting in 'data' only because
        // their stderr happened to contain the word "null".
        /failed to (launch|start|spawn|initialize)/.test(msg) ||
        msg.includes('command not found') || msg.includes('enoent')) {
        return 'config';
    }

    // 6. Data / Validation — explicit patterns only, see DATA_PATTERNS.
    if (DATA_PATTERNS.some((re) => re.test(msg))) {
        return 'data';
    }

    // 7. Logic / Code (NodeOperationError without HTTP status)
    if (type === 'nodeoperationerror') {
        return 'logic';
    }

    // 8. Nothing in the text decided it. Only one node type is strong enough
    //    evidence to act on: a Code node that threw failed in code we control,
    //    which is a logic error by construction.
    //
    //    A tiebreak for HTTP nodes was tried and removed. It turned "Not Found"
    //    and "Not authenticated" into network problems, which they are not — an
    //    HTTP node can fail for any reason at all, so the node type says nothing.
    //    'unknown' is the honest answer when the message carries no signal.
    if (node.includes('.code') || node.includes('function') || node.endsWith('.executecommand')) {
        return 'logic';
    }

    return 'unknown';
}

// A stack's first line is "TypeError: message", or plain "Error: message" for
// anything thrown with `new Error(...)` inside a Code node. Requiring the
// Error/Exception suffix stops this from matching an ordinary message that
// merely happens to contain a colon.
//
// The qualifier prefix must be OPTIONAL. Written as [A-Za-z_$][\w$]*(?:Error)
// it silently fails on bare "Error" — the leading character class eats the "E"
// and nothing is left for the suffix to match. That cost 682 rows on the first
// pass of this backfill, all of them user-thrown Code-node errors.
const STACK_HEADER = /^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))(?::[ \t]*([\s\S]*))?$/;

function parseStackHeader(stack) {
    if (typeof stack !== 'string' || stack === '') return null;
    const firstLine = stack.split('\n', 1)[0].trim();
    const m = STACK_HEADER.exec(firstLine);
    if (!m) return null;
    return { type: m[1], message: (m[2] || '').trim() };
}

/**
 * Reconciles the extracted error fields against the stack, which for the broken
 * rows is the only faithful copy of the text.
 *
 * n8n Code-node failures arrive with no `name` at all and a `message` holding
 * either the error class ("TypeError") or just the leading segment of the real
 * text ("call_center"). 3.643 rows in the replica were stored that way: the
 * message was unusable and the category fell through to 'unknown'. The complete
 * text is always the first line of the stack.
 *
 * Deliberately NOT a blanket "the stack always wins". n8n's structured errors
 * (NodeApiError and friends) carry richer context in `description` than the
 * stack header does, and overriding those would lose detail on the ~10.600 rows
 * that already parse correctly. The stack takes over only when the candidate is
 * demonstrably a truncated form of it.
 */
function reconcileError(candidateMessage, candidateType, stack) {
    const header = parseStackHeader(stack);
    const errorType = (candidateType || '').trim() || (header ? header.type : '');

    let message = (candidateMessage || '').trim();
    if (header && header.message) {
        if (!message) {
            message = header.message;                   // nothing was extracted at all
        } else if (message === header.type) {
            message = header.message;                   // the "TypeError" case
        } else if (header.message.startsWith(message)) {
            message = header.message;                   // the "call_center" case
        }
    }

    // Explicit null beats a plausible-looking sentinel. A row we could not read
    // must stay distinguishable from a row whose error genuinely had no message.
    return { errorType, errorMessage: message || null };
}

/**
 * The single place that decides both fields, so the live sync and the backfill
 * can never disagree. 'unparsed' is not a kind of error — it is an admission
 * that the trace could not be read, kept separate from 'unknown' so a future
 * parser gap shows up as a number instead of hiding in the catch-all bucket.
 */
function resolveError(candidateMessage, candidateType, stack, nodeType, httpCode = null) {
    const { errorType, errorMessage } = reconcileError(candidateMessage, candidateType, stack);
    const errorCategory = errorMessage === null
        ? 'unparsed'
        : classifyError(errorMessage, errorType, nodeType, httpCode);
    return { errorType, errorMessage, errorCategory };
}

module.exports = {
    classifyError,
    parseStackHeader,
    reconcileError,
    resolveError,
    extractHttpCode,
    CLASSIFIER_VERSION,
    DATA_PATTERNS
};
