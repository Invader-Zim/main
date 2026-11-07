// The game page (route/mnp.js, GET /games/:key.:round.:n) offers Detect Scores
// under the same rule as Save: only while the match says this player may report
// the game, and only when the score service is available. The page is rendered
// for real through the route and its templates; the models and the score
// service are stand-ins installed in require.cache before the route loads, so
// nothing reads the data folder or the network.
//
// Run with: npm test

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const express = require('express')
const CONST = require('../constants')

const DETECT_BUTTON = 'id="detect-btn"'
const SAVE_BUTTON = 'id="save-btn"'
const PLAYER_KEY = 'player-1'
const ROUND = 1
const GAME = 1
const MATCH_KEY = 'mnp-99-1-HOM-AWY'

let serviceAvailable = true


function stub(modulePath, exports) {
   const id = require.resolve(modulePath)
   require.cache[id] = { id, filename: id, loaded: true, exports }
}


// A match with just what the game page reads. Reporting is allowed for a
// logged-in player while the match is being played, as the real model does
// for players in either lineup.
function fakeMatch(state) {
   const home = { name: 'Home', key: 'HOM', lineup: [{ key: PLAYER_KEY, name: 'Ann Able' }] }
   const away = { name: 'Away', key: 'AWY', lineup: [{ key: 'player-2', name: 'Bob Baker' }] }
   const game = { n: GAME, machine: 'MACHINE-1' }
   return {
      key: MATCH_KEY,
      name: 'HOM @ AWY',
      week: 1,
      round: ROUND,
      state: state,
      venue: { machines: [] },
      home: home,
      away: away,
      canReport: function(params) {
         return this.state === CONST.PLAYING && params.ukey !== 'ANON' && params.round == this.round
      },
      getGame: function() { return game },
      getOrder: function() { return [away, home] }
   }
}


let match = null
let server = null
let baseUrl = null

before(function(t, done) {
   // The route reads its templates relative to the working directory.
   process.chdir(path.join(__dirname, '..'))
   stub('../model/matches', { get: function(key) { return key === MATCH_KEY ? match : null }, NUM_SCORES: [4, 2, 2, 4, 2] })
   stub('../model/machines', { get: function() { return null } })
   stub('../model/venues', { get: function() { return null } })
   stub('../model/seasons', { get: function() { return { teams: {} } } })
   stub('../model/ratings', {})
   stub('../model/players', { get: function() { return null } })
   stub('../model/stats', {})
   stub('../model/suggestions', { getSuggestions: function() { return [] } })
   stub('../lib/score-service', {
      isConfigured: function() { return true },
      isAvailable: function() { return serviceAvailable },
      recognize: function() { throw new Error('not called by the page') }
   })
   const route = require('../route/mnp')
   const app = express()
   app.use(function(req, res, next) {
      req.user = { key: req.get('X-Test-Player') || undefined }
      next()
   })
   app.use(route)
   server = app.listen(0, function() {
      baseUrl = 'http://127.0.0.1:' + server.address().port
      done()
   })
})

after(function(t, done) {
   server.close(done)
})


// Fetch the game page as the given player (none = not logged in) and say which buttons it has.
async function gamePage(t, player) {
   t.mock.method(console, 'log', function() {})
   const headers = player ? { 'X-Test-Player': player } : {}
   const response = await fetch(baseUrl + '/games/' + MATCH_KEY + '.' + ROUND + '.' + GAME, { headers })
   assert.equal(response.status, 200)
   const html = await response.text()
   return { detect: html.includes(DETECT_BUTTON), save: html.includes(SAVE_BUTTON) }
}


describe('the Detect Scores button goes with the Save button', function() {

   test('a player in a match being played gets both', async function(t) {
      match = fakeMatch(CONST.PLAYING)
      serviceAvailable = true
      assert.deepEqual(await gamePage(t, PLAYER_KEY), { detect: true, save: true })
   })

   test('once the match is complete, neither is offered', async function(t) {
      match = fakeMatch(CONST.COMPLETE)
      serviceAvailable = true
      assert.deepEqual(await gamePage(t, PLAYER_KEY), { detect: false, save: false })
   })

   test('a visitor who is not logged in gets neither', async function(t) {
      match = fakeMatch(CONST.PLAYING)
      serviceAvailable = true
      assert.deepEqual(await gamePage(t), { detect: false, save: false })
   })

   test('without the score service, Save is offered but not Detect Scores', async function(t) {
      match = fakeMatch(CONST.PLAYING)
      serviceAvailable = false
      assert.deepEqual(await gamePage(t, PLAYER_KEY), { detect: false, save: true })
   })
})
