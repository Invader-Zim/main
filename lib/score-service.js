// Client for the score detection service (see the PinballCamera
// docs/server-client-guide.md). Only this server talks to the service; the
// API key never reaches a browser.

const http = require('http')
const https = require('https')
const config = require('../config')

const RECOGNIZE_PATH = '/v1/recognize'
const STATUS_PATH = '/v1/status'
// Asking for progress makes a 200 a stream of events, one JSON object per line.
const PROGRESS_PARAM = 'progress'
const EVENT_STREAM_TYPE = 'application/x-ndjson'
const STATUS_TIMEOUT_MS = 15000
const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401

// Whether the service accepts our key: unknown until checked (or if the
// service couldn't be reached), then valid or invalid.
const KEY_UNKNOWN = 'unknown'
const KEY_VALID = 'valid'
const KEY_INVALID = 'invalid'
let keyStatus = KEY_UNKNOWN


function isConfigured() {
   return !!config.SCORE_SERVICE_API_KEY
}


// Detection is offered unless there's no key or the service has rejected it.
function isAvailable() {
   return isConfigured() && keyStatus !== KEY_INVALID
}


function noteAnswer(status) {
   if (status === HTTP_UNAUTHORIZED) {
      if (keyStatus !== KEY_INVALID) console.log('score service: API key rejected (401); detection turned off')
      keyStatus = KEY_INVALID
   }
   else if (status === HTTP_OK) {
      keyStatus = KEY_VALID
   }
}


// Plain HTTP only for a local copy of the service; the real one is always HTTPS.
function clientFor(url) {
   return url.protocol === 'http:' ? http : https
}


// One keyed request to /v1/status (reads nothing) to learn whether the key works.
function checkKey() {
   if (!isConfigured()) {
      console.log('score service: no SCORE_SERVICE_API_KEY; detection turned off')
      return
   }
   const url = new URL(STATUS_PATH, config.SCORE_SERVICE_URL)
   const req = clientFor(url).request(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + config.SCORE_SERVICE_API_KEY },
      timeout: STATUS_TIMEOUT_MS
   }, function(res) {
      res.resume()
      noteAnswer(res.statusCode)
      console.log('score service: key check ' + res.statusCode + ' -> ' + keyStatus)
   })
   req.on('timeout', function() {
      req.destroy(new Error('timed out'))
   })
   req.on('error', function(err) {
      console.log('score service: key check failed (' + err.message + '); will know after the first reading')
   })
   req.end()
}


// Overload is shed as a retryable 429 (rate limit) or 503 (queue full); a 502/504 from the
// front, or a dropped connection, is transient too. The whole league shares one API key, so
// end-of-round bursts are expected -- retrying here, honouring the service's Retry-After, turns
// a burst refusal into a short wait with the page still getting its scores, rather than a "busy"
// message the player has to act on. Bounded well under the page's ~60s wait; jitter keeps
// simultaneous clients from retrying in lockstep against the one shared token bucket. A genuine
// outage answers connection-refused at once, so the attempts drain the budget in seconds, not 55.
const RETRY_STATUSES = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 10
const RETRY_DEADLINE_MS = 55000
const DEFAULT_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 8000
const RETRY_JITTER_MS = 500
const MIN_ATTEMPT_TIMEOUT_MS = 1000


// How long to wait before the next try: exponential (2s, 4s, 8s...) capped, but never shorter
// than the service's Retry-After when it sent one, plus jitter. Exponential rather than a fixed
// wait because the whole league shares one token bucket -- a fixed interval would have every shed
// client retry together and re-collide; growing it, with jitter, spreads them while the budget
// (not the attempt count) does the real bounding. The cap applies to our own schedule only:
// Retry-After is honoured in full (retrying sooner just collects another refusal), and one that
// reaches past the deadline makes [retry] give up at once rather than wait. The service sends
// Retry-After as seconds; an HTTP-date form would fail the parse and fall back to the schedule.
function backoffMs(retryAfter, number) {
   let wait = Math.min(DEFAULT_BACKOFF_MS * Math.pow(2, number - 1), MAX_BACKOFF_MS)
   const seconds = Number(retryAfter)
   if (Number.isFinite(seconds) && seconds > 0) wait = Math.max(wait, seconds * 1000)
   return wait + Math.floor(Math.random() * RETRY_JITTER_MS)
}


// POST the photo (raw image bytes, or a legacy base64 data URI, both accepted
// as-is by the service) and call back with (err, { status, body, requestId }).
// A retryable refusal or a dropped connection is retried, honouring Retry-After,
// until MAX_ATTEMPTS or the deadline; err is set only when the last try had no HTTP
// answer (network error, timeout, bad JSON).
//
// With an [onProgress] function the service is asked to stream its progress
// (progress=1: newline-delimited JSON, one event per line) and each event is
// passed on as it arrives, along with this module's own retries:
//    { event: 'queued', ahead: N }     N requests are in front of this one
//    { event: 'reading' }              the service has started on the photo
//    { event: 'retry', attempt, waitMs, status, code }
//                                      a refusal (status/code from the service)
//                                      or a dropped connection (status null,
//                                      code the error's) will be tried again
//                                      after waitMs
// No event follows the callback.
//
// Returns { cancel }. cancel() drops the attempt in flight (giving back a place in
// the service's queue), clears any pending retry and forgets the callback: nothing
// is called after it.
function recognize(photo, params, callback, onProgress) {
   const url = new URL(RECOGNIZE_PATH, config.SCORE_SERVICE_URL)
   for (const name of Object.keys(params)) {
      url.searchParams.set(name, String(params[name]))
   }
   if (onProgress) url.searchParams.set(PROGRESS_PARAM, '1')
   const client = clientFor(url)
   const deadline = Date.now() + RETRY_DEADLINE_MS
   let done = false
   let currentReq = null
   let retryTimer = null

   const finish = function(err, result) {
      if (done) return
      done = true
      callback(err, result)
   }

   const progress = function(event) {
      if (!done && onProgress) onProgress(event)
   }

   // Wait and try again if there is an attempt and budget left; otherwise give up with [onLast].
   // [why] says what is being retried: { status, code } for a refusal, { error } for no answer.
   const retry = function(number, wait, why, onLast) {
      if (done) return
      if (number < MAX_ATTEMPTS && Date.now() + wait < deadline) {
         progress({
            event: 'retry',
            attempt: number,
            waitMs: wait,
            status: why.status || null,
            code: why.code || (why.error && why.error.code) || null
         })
         retryTimer = setTimeout(function() { attempt(number + 1) }, wait)
         return
      }
      onLast()
   }

   const attempt = function(number) {
      // No single try runs past the shared deadline, so retries can never overrun the page.
      const timeout = Math.max(MIN_ATTEMPT_TIMEOUT_MS, deadline - Date.now())
      let settled = false

      // A complete answer: a status with its (parsed or null) body.
      const answered = function(status, body, headers) {
         if (settled || done) return
         settled = true
         const requestId = headers['x-request-id'] || (body && body.requestId)
         const deliver = function() {
            noteAnswer(status)
            finish(null, { status, body, requestId })
         }
         if (RETRY_STATUSES.has(status)) {
            console.log('score service: ' + status + ' on try ' + number + ' requestId=' + (requestId || '') + '; may retry')
            retry(number, backoffMs(headers['retry-after'], number), { status, code: body && body.code }, deliver)
         }
         else {
            deliver()
         }
      }

      const failed = function(err) {
         if (settled || done) return
         settled = true
         console.log('score service: ' + err.message + ' on try ' + number + '; may retry')
         retry(number, backoffMs(null, number), { error: err }, function() { finish(err) })
      }

      const req = client.request(url, {
         method: 'POST',
         headers: {
            'Authorization': 'Bearer ' + config.SCORE_SERVICE_API_KEY,
            'Content-Type': 'application/octet-stream',
            'Content-Length': photo.length
         },
         timeout: timeout
      }, function(res) {
         res.setEncoding('utf8')
         if (res.statusCode === HTTP_OK && isEventStream(res.headers)) {
            readEventStream(res, progress, answered, failed)
         }
         else {
            readBody(res, answered)
         }
         res.on('error', failed)
      })

      req.on('timeout', function() {
         req.destroy(new Error('score service timed out'))
      })
      req.on('error', failed)
      req.end(photo)
      currentReq = req
   }

   const cancel = function() {
      if (done) return
      done = true
      clearTimeout(retryTimer)
      if (currentReq) currentReq.destroy()
      console.log('score service: reading cancelled')
   }

   attempt(1)
   return { cancel }
}


function isEventStream(headers) {
   return String(headers['content-type'] || '').indexOf(EVENT_STREAM_TYPE) !== -1
}


// A plain answer: the whole body, parsed as JSON if it is JSON.
function readBody(res, answered) {
   let text = ''
   res.on('data', function(chunk) { text += chunk })
   res.on('end', function() {
      let body = null
      try {
         body = JSON.parse(text)
      }
      catch (e) {
         // A bare 500 (e.g. an oversized body) may not be JSON.
      }
      answered(res.statusCode, body, res.headers)
   })
}


// A progress stream: one JSON event per line. 'queued' and 'reading' are passed on
// as they arrive; the last line is the answer -- 'result' (the normal 200 body) or
// 'error' (the usual problem fields, with the status it would have had). A stream
// that ends with neither was cut off, which counts as a dropped connection.
function readEventStream(res, progress, answered, failed) {
   let pending = ''
   let ended = false

   const takeLine = function(line) {
      if (ended || !line.trim()) return
      let event
      try {
         event = JSON.parse(line)
      }
      catch (e) {
         return   // not ours to interpret; the last line decides the outcome
      }
      if (event.event === 'result') {
         ended = true
         answered(HTTP_OK, event, res.headers)
      }
      else if (event.event === 'error') {
         ended = true
         answered(event.status, event, res.headers)
      }
      else if (event.event === 'queued' || event.event === 'reading') {
         progress(event)
      }
   }

   res.on('data', function(chunk) {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      lines.forEach(takeLine)
   })
   res.on('end', function() {
      takeLine(pending)
      if (!ended) failed(new Error('score service stream ended without a result'))
   })
}


checkKey()

module.exports = {
   isConfigured,
   isAvailable,
   recognize
}
