// Client for the score detection service (see the PinballCamera
// docs/server-client-guide.md). Only this server talks to the service; the
// API key never reaches a browser.

const https = require('https')
const config = require('../config')

const RECOGNIZE_PATH = '/v1/recognize'
const STATUS_PATH = '/v1/status'
const REQUEST_TIMEOUT_MS = 60000
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


// One keyed request to /v1/status (reads nothing) to learn whether the key works.
function checkKey() {
   if (!isConfigured()) {
      console.log('score service: no SCORE_SERVICE_API_KEY; detection turned off')
      return
   }
   const req = https.request(new URL(STATUS_PATH, config.SCORE_SERVICE_URL), {
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


// POST the photo (raw image bytes, or a legacy base64 data URI, both accepted
// as-is by the service) and call back with (err, { status, body, requestId }).
// err is set only when there was no HTTP answer (network error, timeout, bad JSON).
function recognize(photo, params, callback) {
   const url = new URL(RECOGNIZE_PATH, config.SCORE_SERVICE_URL)
   for (const name of Object.keys(params)) {
      url.searchParams.set(name, String(params[name]))
   }
   let done = false
   const finish = function(err, result) {
      if (done) return
      done = true
      callback(err, result)
   }
   const req = https.request(url, {
      method: 'POST',
      headers: {
         'Authorization': 'Bearer ' + config.SCORE_SERVICE_API_KEY,
         'Content-Type': 'application/octet-stream',
         'Content-Length': photo.length
      },
      timeout: REQUEST_TIMEOUT_MS
   }, function(res) {
      const chunks = []
      res.on('data', function(chunk) { chunks.push(chunk) })
      res.on('end', function() {
         const text = Buffer.concat(chunks).toString('utf8')
         let body = null
         try {
            body = JSON.parse(text)
         }
         catch (e) {
            // A bare 500 (e.g. an oversized body) may not be JSON.
         }
         noteAnswer(res.statusCode)
         finish(null, { status: res.statusCode, body, requestId: res.headers['x-request-id'] || (body && body.requestId) })
      })
      res.on('error', finish)
   })
   req.on('timeout', function() {
      req.destroy(new Error('score service timed out'))
   })
   req.on('error', finish)
   req.end(photo)
}

checkKey()

module.exports = {
   isConfigured,
   isAvailable,
   recognize
}
