// Tests for lib/score-service.js with https mocked: nothing here reaches a
// network. Run with: node --test test/score-service.test.js
//
// The service is described in the PinballCamera docs (server-client-guide.md
// and server-api.md): 429/503 carry Retry-After and are retried, 502/504 come
// from the proxy without one and are retried with our own backoff, every
// other status is final, and a 401 means the key is bad.

const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const https = require('node:https')
const config = require('../config')

const SERVICE_PATH = require.resolve('../lib/score-service')
const TEST_KEY = 'test-key'
const TEST_URL = 'https://score.test'
const LOCAL_URL = 'http://127.0.0.1:8080'
const EVENT_STREAM_TYPE = 'application/x-ndjson'
const START_MS = 1_000_000

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415
const HTTP_UNPROCESSABLE = 422
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_INTERNAL = 500
const HTTP_BAD_GATEWAY = 502
const HTTP_SERVICE_UNAVAILABLE = 503
const HTTP_GATEWAY_TIMEOUT = 504

// The module's own tuning (not exported); the expectations below are derived from these.
const STATUS_TIMEOUT_MS = 15000
const RETRY_DEADLINE_MS = 55000
const DEFAULT_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 8000
const MIN_ATTEMPT_TIMEOUT_MS = 1000

// With jitter mocked to 0 the waits are 2s, 4s, then 8s each. Nine tries fit: the ninth
// begins at 54s and a further 8s wait would pass the 55s deadline.
const ATTEMPTS_UNTIL_DEADLINE = 9
const LAST_ATTEMPT_AT_MS = 54000

const PHOTO = Buffer.from('not really a jpeg')
const PARAMS = { playerCount: 4, rot: 0, scale: 2.656, dx: -252, dy: -279 }
const REQUEST_ID = '3f6c1d2e-8a4b-4c0e-9f1a-2b7d5e6a9c10'

const GOOD_READING = {
   requestId: REQUEST_ID,
   machine: { resolved: { name: 'Target Alpha', accepted: true } },
   scores: { maxPlayers: 4, positions: [{ position: 1, score: { numericValue: 75670, confidence: 0.99 } }] },
   warnings: [],
   attribution: { poweredBy: 'Powered by Flippd Pinball Vision.' }
}


// An answer the fake service gives to one request: a status with headers and a body
// (an object is sent as JSON, a string as-is), a connection error, or nothing at all
// (the test then fires the timeout itself).
function ok(body, headers) {
   return { status: HTTP_OK, headers: headers || { 'x-request-id': REQUEST_ID }, body: body || GOOD_READING }
}


function problem(status, code, headers) {
   return { status, headers: Object.assign({ 'x-request-id': REQUEST_ID }, headers), body: { status, code, requestId: REQUEST_ID } }
}


function refused() {
   return { error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
}


function hang() {
   return { hang: true }
}


// A 200 progress stream: the events, one JSON line each, sent in the given chunks
// (default one chunk per line). `cut` ends the stream after the chunks as if the
// connection dropped.
function stream(events, options) {
   options = options || {}
   const chunks = options.chunks || events.map(function(e) { return JSON.stringify(e) + '\n' })
   return {
      status: HTTP_OK,
      headers: { 'content-type': EVENT_STREAM_TYPE, 'x-request-id': REQUEST_ID },
      chunks: chunks
   }
}


const QUEUED_2 = { event: 'queued', ahead: 2 }
const QUEUED_1 = { event: 'queued', ahead: 1 }
const READING = { event: 'reading' }
const RESULT_LINE = Object.assign({ event: 'result' }, GOOD_READING)


// A stand-in for https.request that answers from a script, one entry per request, and
// records what each request sent. Responses are delivered synchronously inside end() so
// the tests need no real I/O and mocked timers drive every retry.
function fakeHttps(answers) {
   const calls = []

   function request(url, options, onResponse) {
      const req = new EventEmitter()
      const call = {
         url: String(url),
         method: options.method,
         headers: options.headers,
         timeout: options.timeout,
         body: undefined,
         req: req
      }
      calls.push(call)
      req.destroy = function(err) {
         req.destroyed = true
         if (err) req.emit('error', err)
      }
      req.end = function(body) {
         call.body = body
         const answer = answers.shift()
         assert.ok(answer, 'unscripted request to ' + call.url)
         if (answer.hang) return
         if (answer.error) {
            req.emit('error', answer.error)
            return
         }
         const res = new EventEmitter()
         res.statusCode = answer.status
         res.headers = answer.headers || {}
         res.resume = function() {}
         res.setEncoding = function() {}
         onResponse(res)
         const chunks = answer.chunks || [typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)]
         chunks.forEach(function(chunk) { res.emit('data', chunk) })
         res.emit('end')
      }
      return req
   }

   return {
      request,
      calls,
      // The POSTs to /v1/recognize, i.e. every call but the start-up key check.
      attempts: function() {
         return calls.filter(function(c) { return new URL(c.url).pathname === '/v1/recognize' })
      }
   }
}


// Load a fresh copy of the module behind the fake (http and https, so either URL scheme
// lands in it), with mocked timers, no jitter and no console noise. The module checks the key on load, so the first scripted answer is for
// that GET /v1/status; `keyCheck` defaults to a 200.
function load(t, options) {
   options = options || {}
   const answers = [options.keyCheck || ok({ ready: true })].concat(options.answers || [])
   const fake = fakeHttps(answers)
   t.mock.method(https, 'request', fake.request)
   t.mock.method(http, 'request', fake.request)
   t.mock.method(Math, 'random', function() { return 0 })
   t.mock.method(console, 'log', function() {})
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START_MS })
   config.SCORE_SERVICE_API_KEY = 'key' in options ? options.key : TEST_KEY
   config.SCORE_SERVICE_URL = options.url || TEST_URL
   delete require.cache[SERVICE_PATH]
   const service = require(SERVICE_PATH)
   return { service, fake }
}


// Advance the mocked clock in 1ms steps. A single tick(ms) jumps Date.now() to the end
// before running any timer, so a retry scheduled during the tick would see the deadline
// as already passed; stepping keeps Date.now() true to when each timer fires.
function advance(t, ms) {
   for (let i = 0; i < ms; i++) t.mock.timers.tick(1)
}


// Call recognize and capture its one callback. With `progress: true` an onProgress
// function is passed too, and every event it gets is collected in `events`.
function callRecognize(service, photo, params, options) {
   options = options || {}
   const outcome = { called: 0, err: undefined, answer: undefined, events: [] }
   const onProgress = options.progress ? function(event) { outcome.events.push(event) } : undefined
   service.recognize(photo || PHOTO, params || PARAMS, function(err, answer) {
      outcome.called++
      outcome.err = err
      outcome.answer = answer
   }, onProgress)
   return outcome
}


beforeEach(function() {
   delete require.cache[SERVICE_PATH]
})


describe('configuration and the start-up key check', function() {

   test('without a key nothing is requested and detection is off', function(t) {
      const { service, fake } = load(t, { key: '' })
      assert.equal(service.isConfigured(), false)
      assert.equal(service.isAvailable(), false)
      assert.equal(fake.calls.length, 0)
   })

   test('with a key, one keyed GET /v1/status is sent on load', function(t) {
      const { service, fake } = load(t)
      assert.equal(fake.calls.length, 1)
      const call = fake.calls[0]
      assert.equal(call.url, TEST_URL + '/v1/status')
      assert.equal(call.method, 'GET')
      assert.equal(call.headers.Authorization, 'Bearer ' + TEST_KEY)
      assert.equal(call.timeout, STATUS_TIMEOUT_MS)
      assert.equal(call.body, undefined)
      assert.equal(service.isConfigured(), true)
      assert.equal(service.isAvailable(), true)
   })

   test('a 401 from the key check turns detection off', function(t) {
      const { service } = load(t, { keyCheck: problem(HTTP_UNAUTHORIZED, 'unauthorized') })
      assert.equal(service.isConfigured(), true)
      assert.equal(service.isAvailable(), false)
   })

   test('an unreachable service at start-up leaves detection on', function(t) {
      const { service } = load(t, { keyCheck: refused() })
      assert.equal(service.isAvailable(), true)
   })

   test('a key check that times out is destroyed and leaves detection on', function(t) {
      const { service, fake } = load(t, { keyCheck: hang() })
      fake.calls[0].req.emit('timeout')
      assert.equal(fake.calls[0].req.destroyed, true)
      assert.equal(service.isAvailable(), true)
   })
})


describe('recognize: the request', function() {

   test('POSTs the photo bytes with the key and the params in the query', function(t) {
      const { service, fake } = load(t, { answers: [ok()] })
      callRecognize(service)
      const [call] = fake.attempts()
      assert.equal(call.method, 'POST')
      const url = new URL(call.url)
      assert.equal(url.origin + url.pathname, TEST_URL + '/v1/recognize')
      assert.deepEqual(Object.fromEntries(url.searchParams),
         { playerCount: '4', rot: '0', scale: '2.656', dx: '-252', dy: '-279' })
      assert.equal(call.headers.Authorization, 'Bearer ' + TEST_KEY)
      assert.equal(call.headers['Content-Type'], 'application/octet-stream')
      assert.equal(call.headers['Content-Length'], PHOTO.length)
      assert.equal(call.body, PHOTO)
   })

   test('sends a stored data URI as-is', function(t) {
      const dataUri = 'data:image/png;base64,iVBORw0KGgo='
      const { service, fake } = load(t, { answers: [ok()] })
      callRecognize(service, dataUri, { playerCount: 2 })
      const [call] = fake.attempts()
      assert.equal(call.body, dataUri)
      assert.equal(call.headers['Content-Length'], dataUri.length)
      assert.equal(new URL(call.url).search, '?playerCount=2')
   })

   test('the first attempt may run for the whole retry deadline', function(t) {
      const { service, fake } = load(t, { answers: [ok()] })
      callRecognize(service)
      assert.equal(fake.attempts()[0].timeout, RETRY_DEADLINE_MS)
   })
})


describe('recognize: answers', function() {

   test('a 200 reading is delivered with the requestId from the header', function(t) {
      const { service } = load(t, { answers: [ok()] })
      const outcome = callRecognize(service)
      assert.equal(outcome.called, 1)
      assert.equal(outcome.err, null)
      assert.deepEqual(outcome.answer, { status: HTTP_OK, body: GOOD_READING, requestId: REQUEST_ID })
   })

   test('the requestId falls back to the body when the header is missing', function(t) {
      const { service } = load(t, { answers: [ok(GOOD_READING, {})] })
      const outcome = callRecognize(service)
      assert.equal(outcome.answer.requestId, REQUEST_ID)
   })

   test('a bare non-JSON 500 is delivered with a null body and no error', function(t) {
      const { service } = load(t, { answers: [{ status: HTTP_INTERNAL, headers: {}, body: 'Internal Server Error' }] })
      const outcome = callRecognize(service)
      assert.equal(outcome.err, null)
      assert.deepEqual(outcome.answer, { status: HTTP_INTERNAL, body: null, requestId: null })
   })

   describe('400, 415 and 422 are final: delivered at once, not retried', function() {
      const finals = [
         [HTTP_BAD_REQUEST, 'invalid_parameter'],
         [HTTP_UNSUPPORTED_MEDIA_TYPE, 'unsupported_media_type'],
         [HTTP_UNPROCESSABLE, 'undecodable_image']
      ]
      for (const [status, code] of finals) {
         test(status + ' ' + code, function(t) {
            const { service, fake } = load(t, { answers: [problem(status, code)] })
            const outcome = callRecognize(service)
            advance(t, RETRY_DEADLINE_MS)
            assert.equal(fake.attempts().length, 1)
            assert.equal(outcome.called, 1)
            assert.equal(outcome.answer.status, status)
            assert.equal(outcome.answer.body.code, code)
            assert.equal(service.isAvailable(), true)
         })
      }
   })

   test('a 401 reading turns detection off; a later 200 turns it back on', function(t) {
      const { service } = load(t, { answers: [problem(HTTP_UNAUTHORIZED, 'unauthorized'), ok()] })
      const first = callRecognize(service)
      assert.equal(first.answer.status, HTTP_UNAUTHORIZED)
      assert.equal(service.isAvailable(), false)
      callRecognize(service)
      assert.equal(service.isAvailable(), true)
   })
})


describe('recognize: retrying', function() {

   test('a 429 is retried after its Retry-After, then the reading is delivered', function(t) {
      const RETRY_AFTER_S = 3
      const { service, fake } = load(t, {
         answers: [problem(HTTP_TOO_MANY_REQUESTS, 'rate_limited', { 'retry-after': String(RETRY_AFTER_S) }), ok()]
      })
      const outcome = callRecognize(service)
      assert.equal(outcome.called, 0)
      t.mock.timers.tick(RETRY_AFTER_S * 1000 - 1)
      assert.equal(fake.attempts().length, 1, 'waits the full Retry-After')
      t.mock.timers.tick(1)
      assert.equal(fake.attempts().length, 2)
      assert.equal(outcome.called, 1)
      assert.equal(outcome.err, null)
      assert.equal(outcome.answer.status, HTTP_OK)
   })

   test('a short Retry-After never shortens the exponential wait', function(t) {
      const { service, fake } = load(t, {
         answers: [problem(HTTP_SERVICE_UNAVAILABLE, 'busy', { 'retry-after': '1' }), ok()]
      })
      callRecognize(service)
      t.mock.timers.tick(DEFAULT_BACKOFF_MS - 1)
      assert.equal(fake.attempts().length, 1)
      t.mock.timers.tick(1)
      assert.equal(fake.attempts().length, 2)
   })

   describe('503 busy, 503 warming_up, 502 and 504 are all retried', function() {
      const transient = [
         ['503 busy', problem(HTTP_SERVICE_UNAVAILABLE, 'busy')],
         ['503 warming_up', problem(HTTP_SERVICE_UNAVAILABLE, 'warming_up')],
         ['502 from the proxy, not JSON', { status: HTTP_BAD_GATEWAY, headers: {}, body: '<html>502 Bad Gateway</html>' }],
         ['504 from the proxy, empty', { status: HTTP_GATEWAY_TIMEOUT, headers: {}, body: '' }]
      ]
      for (const [name, answer] of transient) {
         test(name, function(t) {
            const { service, fake } = load(t, { answers: [answer, ok()] })
            const outcome = callRecognize(service)
            assert.equal(outcome.called, 0)
            t.mock.timers.tick(DEFAULT_BACKOFF_MS)
            assert.equal(fake.attempts().length, 2)
            assert.equal(outcome.answer.status, HTTP_OK)
         })
      }
   })

   test('waits grow 2s, 4s, 8s and stay capped at 8s', function(t) {
      const busy = function() { return problem(HTTP_SERVICE_UNAVAILABLE, 'busy') }
      const { service, fake } = load(t, { answers: [busy(), busy(), busy(), busy(), ok()] })
      callRecognize(service)
      const waits = [DEFAULT_BACKOFF_MS, 2 * DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]
      waits.forEach(function(wait, i) {
         t.mock.timers.tick(wait - 1)
         assert.equal(fake.attempts().length, i + 1, 'still waiting before try ' + (i + 2))
         t.mock.timers.tick(1)
         assert.equal(fake.attempts().length, i + 2, 'try ' + (i + 2) + ' sent')
      })
   })

   test('a dropped connection is retried and the reading still arrives', function(t) {
      const { service, fake } = load(t, { answers: [refused(), ok()] })
      const outcome = callRecognize(service)
      t.mock.timers.tick(DEFAULT_BACKOFF_MS)
      assert.equal(fake.attempts().length, 2)
      assert.equal(outcome.err, null)
      assert.equal(outcome.answer.status, HTTP_OK)
   })

   test('a timed-out attempt is destroyed and retried', function(t) {
      const { service, fake } = load(t, { answers: [hang(), ok()] })
      const outcome = callRecognize(service)
      const first = fake.attempts()[0]
      first.req.emit('timeout')
      assert.equal(first.req.destroyed, true)
      t.mock.timers.tick(DEFAULT_BACKOFF_MS)
      assert.equal(fake.attempts().length, 2)
      assert.equal(outcome.answer.status, HTTP_OK)
   })

   test('later attempts are timed to the shared deadline, never under 1s', function(t) {
      const busy = function() { return problem(HTTP_SERVICE_UNAVAILABLE, 'busy') }
      const { service, fake } = load(t, { answers: Array.from({ length: ATTEMPTS_UNTIL_DEADLINE }, busy) })
      callRecognize(service)
      t.mock.timers.tick(DEFAULT_BACKOFF_MS)
      assert.equal(fake.attempts()[1].timeout, RETRY_DEADLINE_MS - DEFAULT_BACKOFF_MS)
      advance(t, RETRY_DEADLINE_MS)
      const last = fake.attempts()[ATTEMPTS_UNTIL_DEADLINE - 1]
      assert.equal(last.timeout, MIN_ATTEMPT_TIMEOUT_MS)
   })

   test('a service that stays busy: the last 503 is delivered before the deadline', function(t) {
      const busy = function() { return problem(HTTP_SERVICE_UNAVAILABLE, 'busy') }
      const { service, fake } = load(t, { answers: Array.from({ length: ATTEMPTS_UNTIL_DEADLINE }, busy) })
      const outcome = callRecognize(service)
      advance(t, LAST_ATTEMPT_AT_MS - 1)
      assert.equal(outcome.called, 0)
      t.mock.timers.tick(1)
      assert.equal(fake.attempts().length, ATTEMPTS_UNTIL_DEADLINE)
      assert.equal(outcome.called, 1)
      assert.equal(outcome.err, null)
      assert.equal(outcome.answer.status, HTTP_SERVICE_UNAVAILABLE)
      assert.equal(outcome.answer.body.code, 'busy')
      advance(t, RETRY_DEADLINE_MS)
      assert.equal(fake.attempts().length, ATTEMPTS_UNTIL_DEADLINE, 'nothing sent after the deadline')
      assert.equal(outcome.called, 1)
   })

   test('a service that stays down: the last connection error is the callback error', function(t) {
      const { service, fake } = load(t, { answers: Array.from({ length: ATTEMPTS_UNTIL_DEADLINE }, refused) })
      const outcome = callRecognize(service)
      advance(t, RETRY_DEADLINE_MS)
      assert.equal(fake.attempts().length, ATTEMPTS_UNTIL_DEADLINE)
      assert.equal(outcome.called, 1)
      assert.equal(outcome.err.code, 'ECONNREFUSED')
      assert.equal(outcome.answer, undefined)
   })

   test('a stray timeout after the answer arrived does not call back twice', function(t) {
      const { service, fake } = load(t, { answers: [ok()] })
      const outcome = callRecognize(service)
      assert.equal(outcome.called, 1)
      fake.attempts()[0].req.emit('timeout')
      advance(t, RETRY_DEADLINE_MS)
      assert.equal(outcome.called, 1)
      assert.equal(fake.attempts().length, 1)
   })

   test('a Retry-After longer than the 8s cap is honoured in full', function(t) {
      const RETRY_AFTER_S = 20
      const { service, fake } = load(t, {
         answers: [problem(HTTP_TOO_MANY_REQUESTS, 'rate_limited', { 'retry-after': String(RETRY_AFTER_S) }), ok()]
      })
      const outcome = callRecognize(service)
      advance(t, RETRY_AFTER_S * 1000 - 1)
      assert.equal(fake.attempts().length, 1, 'waits the full Retry-After, past the 8s cap')
      t.mock.timers.tick(1)
      assert.equal(fake.attempts().length, 2)
      assert.equal(outcome.answer.status, HTTP_OK)
   })

   test('a Retry-After past the deadline gives up at once with the refusal', function(t) {
      const RETRY_AFTER_S = 60
      const { service, fake } = load(t, {
         answers: [problem(HTTP_SERVICE_UNAVAILABLE, 'busy', { 'retry-after': String(RETRY_AFTER_S) })]
      })
      const outcome = callRecognize(service)
      assert.equal(outcome.called, 1)
      assert.equal(outcome.err, null)
      assert.equal(outcome.answer.status, HTTP_SERVICE_UNAVAILABLE)
      assert.equal(outcome.answer.body.code, 'busy')
      advance(t, RETRY_AFTER_S * 1000)
      assert.equal(fake.attempts().length, 1, 'never retried')
      assert.equal(outcome.called, 1)
   })

   test('a non-numeric Retry-After falls back to the exponential wait', function(t) {
      const { service, fake } = load(t, {
         answers: [problem(HTTP_TOO_MANY_REQUESTS, 'rate_limited', { 'retry-after': 'Thu, 06 Nov 2026 20:00:00 GMT' }), ok()]
      })
      callRecognize(service)
      t.mock.timers.tick(DEFAULT_BACKOFF_MS - 1)
      assert.equal(fake.attempts().length, 1)
      t.mock.timers.tick(1)
      assert.equal(fake.attempts().length, 2)
   })
})


describe('recognize: progress and the event stream', function() {

   test('progress=1 is asked for only when an onProgress function is given', function(t) {
      const { service, fake } = load(t, { answers: [ok(), stream([READING, RESULT_LINE])] })
      callRecognize(service)
      assert.equal(new URL(fake.attempts()[0].url).searchParams.get('progress'), null)
      callRecognize(service, null, null, { progress: true })
      assert.equal(new URL(fake.attempts()[1].url).searchParams.get('progress'), '1')
   })

   test('queued and reading events are passed on, then the result line is the 200 answer', function(t) {
      const { service } = load(t, { answers: [stream([QUEUED_2, QUEUED_1, READING, RESULT_LINE])] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.events, [QUEUED_2, QUEUED_1, READING])
      assert.equal(outcome.called, 1)
      assert.equal(outcome.err, null)
      assert.equal(outcome.answer.status, HTTP_OK)
      assert.deepEqual(outcome.answer.body, RESULT_LINE)
      assert.equal(outcome.answer.requestId, REQUEST_ID)
      assert.equal(service.isAvailable(), true)
   })

   test('lines split across chunks and several lines in one chunk are both read', function(t) {
      const text = [QUEUED_1, READING, RESULT_LINE].map(function(e) { return JSON.stringify(e) + '\n' }).join('')
      const cut = text.indexOf('"ahead"') + 3
      const { service } = load(t, { answers: [stream([], { chunks: [text.slice(0, cut), text.slice(cut)] })] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.events, [QUEUED_1, READING])
      assert.deepEqual(outcome.answer.body, RESULT_LINE)
   })

   test('a result line without a trailing newline still counts', function(t) {
      const { service } = load(t, { answers: [stream([], { chunks: [JSON.stringify(READING) + '\n' + JSON.stringify(RESULT_LINE)] })] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.equal(outcome.answer.status, HTTP_OK)
      assert.deepEqual(outcome.answer.body, RESULT_LINE)
   })

   test('an error line is delivered with its own status and is not retried', function(t) {
      const errorLine = { event: 'error', status: HTTP_UNPROCESSABLE, code: 'undecodable_image', requestId: REQUEST_ID }
      const { service, fake } = load(t, { answers: [stream([READING, errorLine])] })
      const outcome = callRecognize(service, null, null, { progress: true })
      advance(t, RETRY_DEADLINE_MS)
      assert.equal(fake.attempts().length, 1)
      assert.deepEqual(outcome.events, [READING])
      assert.equal(outcome.err, null)
      assert.equal(outcome.answer.status, HTTP_UNPROCESSABLE)
      assert.equal(outcome.answer.body.code, 'undecodable_image')
   })

   test('a stream cut off before its last line is retried like a dropped connection', function(t) {
      const { service, fake } = load(t, { answers: [stream([QUEUED_1, READING]), stream([READING, RESULT_LINE])] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.equal(outcome.called, 0)
      assert.equal(outcome.events.length, 3)
      assert.equal(outcome.events[2].event, 'retry')
      assert.equal(outcome.events[2].status, null)
      t.mock.timers.tick(DEFAULT_BACKOFF_MS)
      assert.equal(fake.attempts().length, 2)
      assert.deepEqual(outcome.events.slice(3), [READING])
      assert.equal(outcome.answer.status, HTTP_OK)
   })

   test('a refusal reports a retry event, with the wait, before waiting', function(t) {
      const RETRY_AFTER_S = 3
      const { service } = load(t, {
         answers: [problem(HTTP_TOO_MANY_REQUESTS, 'rate_limited', { 'retry-after': String(RETRY_AFTER_S) }), stream([RESULT_LINE])]
      })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.events, [
         { event: 'retry', attempt: 1, waitMs: RETRY_AFTER_S * 1000, status: HTTP_TOO_MANY_REQUESTS, code: 'rate_limited' }
      ])
      advance(t, RETRY_AFTER_S * 1000)
      assert.equal(outcome.answer.status, HTTP_OK)
   })

   test('a dropped connection reports a retry event with the error code', function(t) {
      const { service } = load(t, { answers: [refused(), ok()] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.events, [
         { event: 'retry', attempt: 1, waitMs: DEFAULT_BACKOFF_MS, status: null, code: 'ECONNREFUSED' }
      ])
   })

   test('a proxy 502 reports a retry event with no code', function(t) {
      const { service } = load(t, { answers: [{ status: HTTP_BAD_GATEWAY, headers: {}, body: '<html>502</html>' }, ok()] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.events, [
         { event: 'retry', attempt: 1, waitMs: DEFAULT_BACKOFF_MS, status: HTTP_BAD_GATEWAY, code: null }
      ])
   })

   test('giving up sends no retry event, and nothing follows the callback', function(t) {
      const { service } = load(t, {
         answers: [problem(HTTP_SERVICE_UNAVAILABLE, 'busy', { 'retry-after': '60' })]
      })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.equal(outcome.called, 1)
      assert.deepEqual(outcome.events, [])
      advance(t, RETRY_DEADLINE_MS)
      assert.deepEqual(outcome.events, [])
   })

   test('a plain JSON 200 is the answer even when progress was asked for', function(t) {
      const { service } = load(t, { answers: [ok()] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.events, [])
      assert.deepEqual(outcome.answer.body, GOOD_READING)
   })

   test('a non-JSON line in the stream is ignored', function(t) {
      const { service } = load(t, { answers: [stream([], { chunks: [': keep-alive\n' + JSON.stringify(RESULT_LINE) + '\n'] })] })
      const outcome = callRecognize(service, null, null, { progress: true })
      assert.deepEqual(outcome.answer.body, RESULT_LINE)
   })
})


describe('a local http:// service', function() {

   test('is called over plain http, for the key check and the reading', function(t) {
      const { service, fake } = load(t, { url: LOCAL_URL, answers: [ok()] })
      callRecognize(service)
      assert.equal(https.request.mock.callCount(), 0)
      assert.equal(http.request.mock.callCount(), 2)
      assert.equal(fake.calls[0].url, LOCAL_URL + '/v1/status')
      assert.ok(fake.attempts()[0].url.startsWith(LOCAL_URL + '/v1/recognize?'))
   })
})
