/**
 * Tests for the error parser and classifier.
 *
 *   node src/scripts/testErrorParser.js
 *
 * Every case here is either a real row taken from the production replica or a
 * shape observed in an n8n trace — no invented inputs. The point is to stop the
 * classification rules from quietly getting worse in a later refactor: they are
 * a pile of heuristics, and heuristics rot silently unless something checks them.
 */
const {
    parseStackHeader,
    reconcileError,
    classifyError,
    extractHttpCode,
    resolveError
} = require('../config/errorParser');

let passed = 0;
const failures = [];

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) passed++;
    else failures.push(`${name}\n      expected ${e}\n      got      ${a}`);
}

// For cases where one answer is definitely wrong but several are defensible.
// Asserting equality there would pin down a decision the evidence does not
// support, and would fail the day someone legitimately improves the rule.
function checkNot(name, actual, forbidden) {
    if (actual !== forbidden) passed++;
    else failures.push(`${name}\n      must NOT be ${JSON.stringify(forbidden)}`);
}

// ── stack headers ────────────────────────────────────────────────────────────
check('stack: TypeError with message',
    parseStackHeader("TypeError: Cannot read properties of undefined (reading 'id')\n    at VmCodeWrapper"),
    { type: 'TypeError', message: "Cannot read properties of undefined (reading 'id')" });

// The regression that cost 682 rows: a bare "Error" prefix must still match.
check('stack: bare Error prefix',
    parseStackHeader('Error: call_center: 18 names, 21 values\n    at foo'),
    { type: 'Error', message: 'call_center: 18 names, 21 values' });

check('stack: no colon', parseStackHeader('Error'), { type: 'Error', message: '' });
check('stack: not a header', parseStackHeader('at Object.foo (file:1:2)'), null);
check('stack: ordinary sentence with a colon', parseStackHeader('Warning: something happened'), null);
check('stack: empty', parseStackHeader(''), null);
check('stack: not a string', parseStackHeader(null), null);

// ── reconciliation ───────────────────────────────────────────────────────────
check('reconcile: class name is replaced by the real message',
    reconcileError('TypeError', '', "TypeError: Cannot read properties of undefined (reading 'id')\n at x"),
    { errorType: 'TypeError', errorMessage: "Cannot read properties of undefined (reading 'id')" });

check('reconcile: truncated message is completed',
    reconcileError('call_center', '', 'Error: call_center: 18 names, 21 values\n at x'),
    { errorType: 'Error', errorMessage: 'call_center: 18 names, 21 values' });

// The guard against over-reach: a structured n8n error keeps its own richer
// description instead of being flattened to the stack header.
check('reconcile: a good description is NOT overwritten by the stack',
    reconcileError('The service is currently unavailable.', 'NodeApiError',
        'NodeApiError: The service was not able to process your request\n at x'),
    { errorType: 'NodeApiError', errorMessage: 'The service is currently unavailable.' });

check('reconcile: nothing readable yields null',
    reconcileError('', '', ''),
    { errorType: '', errorMessage: null });

check('reconcile: whitespace only yields null',
    reconcileError('   \n ', '', ''),
    { errorType: '', errorMessage: null });

// ── httpCode extraction ──────────────────────────────────────────────────────
check('http: httpCode as a number', extractHttpCode({ httpCode: 429 }), 429);
check('http: httpCode as a string', extractHttpCode({ httpCode: '503' }), 503);
check('http: nested in context', extractHttpCode({ context: { httpCode: 401 } }), 401);
check('http: from a response object', extractHttpCode({ response: { status: 404 } }), 404);
check('http: absent', extractHttpCode({ message: 'boom' }), null);
check('http: out of range is rejected', extractHttpCode({ statusCode: 99999 }), null);
check('http: null input', extractHttpCode(null), null);

// ── classification: httpCode outranks the text ───────────────────────────────
check('classify: 429 wins', classifyError('something went wrong', '', '', 429), 'rate_limit');
check('classify: 401 wins', classifyError('something went wrong', '', '', 401), 'auth');
check('classify: 502 wins', classifyError('something went wrong', '', '', 502), 'upstream');
check('classify: 400 is our data', classifyError('something went wrong', '', '', 400), 'data');

// An order id that merely contains 429 must not read as a rate limit once a
// real status is present.
check('classify: real status beats a number inside the text',
    classifyError('order 429 could not be found', '', '', 404), 'data');

// ── classification: real messages from the replica ───────────────────────────
check('classify: undefined property read',
    classifyError("cannot read properties of undefined (reading 'id')", 'TypeError', ''), 'data');
check('classify: connection refused',
    classifyError('connect ECONNREFUSED 46.225.80.80:5436', '', ''), 'network');
check('classify: rate limit in text',
    classifyError('Too Many Requests - rate limit reached', 'NodeApiError', ''), 'rate_limit');
check('classify: unauthorized in text',
    classifyError('Unauthorized - please check your credentials', 'NodeApiError', ''), 'auth');
check('classify: service unavailable',
    classifyError('The service is currently unavailable.', 'NodeApiError', ''), 'upstream');

// ── classification: the narrowed data rules ──────────────────────────────────
// These used to be swallowed by bare 'null' / 'missing' / 'invalid' substring
// matches, which put 6.723 of 14.203 rows into 'data'.
check('classify: a bare mention of null is no longer data',
    classifyError('the customer record was null in the source system', '', ''), 'unknown');
check('classify: "missing" alone is no longer data',
    classifyError('report missing for yesterday', '', ''), 'unknown');
check('classify: but a real parse failure still is',
    classifyError('Unexpected token < in JSON at position 0', 'SyntaxError', ''), 'data');
check('classify: and so is a required field',
    classifyError('required property "email" not supplied', '', ''), 'data');

// ── classification: node type as the tiebreak ────────────────────────────────
check('classify: unrecognised failure in a Code node is logic',
    classifyError('script blew up', 'Error', 'n8n-nodes-base.code'), 'logic');
check('classify: unrecognised failure with no node stays unknown',
    classifyError('something odd', '', ''), 'unknown');
check('classify: NodeOperationError still beats the node tiebreak',
    classifyError('something odd', 'NodeOperationError', 'n8n-nodes-base.httpRequest'), 'logic');

// An HTTP node says nothing about the cause. These two were network until the
// tiebreak was removed, and neither is a network problem.
check('classify: "Not Found" from an HTTP node is not a network error',
    classifyError('Not Found', 'NodeApiError', 'n8n-nodes-base.httpRequest'), 'unknown');
check('classify: "Not authenticated" is auth, not network',
    classifyError('Not authenticated', 'NodeApiError', 'n8n-nodes-base.httpRequest'), 'auth');

// ── regressions found by auditing the real table ─────────────────────────────
// A local chromium crash whose stderr contains the OS text "Resource temporarily
// unavailable". 1.316 rows were reclassified as upstream outages by a rule that
// looked reasonable in isolation.
// A process that will not start is an environment problem. These 1.309 rows sat
// in 'data' only because their stderr contained the word "null", and a rule
// added during this work briefly made them 'upstream'.
check('classify: a process that will not launch is config',
    classifyError(
        'Failed to launch the browser process: Code: null stderr: /usr/bin/chromium: ' +
        'fork failed: Resource temporarily unavailable', 'NodeApiError', ''),
    'config');

checkNot('classify: embedded EAGAIN text is never an upstream outage',
    classifyError(
        'Failed to launch the browser process: Code: null stderr: ' +
        'fork failed: Resource temporarily unavailable', 'NodeApiError', ''),
    'upstream');

check('classify: a genuinely unavailable service is upstream',
    classifyError('The service is currently unavailable.', 'NodeApiError', ''), 'upstream');

check('classify: Node type-mismatch wording is data, not generic logic',
    classifyError('The first argument must be of type string or an instance of Buffer',
        'NodeOperationError', ''), 'data');

check('classify: an invalid URL is data, not generic logic',
    classifyError('Invalid URL: as. URL must start with "http" or "https".',
        'NodeOperationError', ''), 'data');

check('classify: a rejected Postgres row is data',
    classifyError('Failing row contains (null, New, 46131.63, DSLAM)', 'NodeOperationError', ''), 'data');

check('classify: connection closed unexpectedly is network',
    classifyError('The connection to the server was closed unexpectedly, perhaps it is offline',
        'NodeApiError', ''), 'network');

// ── end to end ───────────────────────────────────────────────────────────────
check('resolve: unreadable trace is unparsed, not unknown',
    resolveError('', '', '', 'n8n-nodes-base.code'),
    { errorType: '', errorMessage: null, errorCategory: 'unparsed' });

check('resolve: the 2.948-row case, end to end',
    resolveError('TypeError', '', "TypeError: Cannot read properties of undefined (reading 'id')\n at x", 'Unknown Type'),
    {
        errorType: 'TypeError',
        errorMessage: "Cannot read properties of undefined (reading 'id')",
        errorCategory: 'data'
    });

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
    for (const f of failures) console.error(`  FAIL  ${f}\n`);
    process.exit(1);
}
console.log('All error-parser tests passed.');
