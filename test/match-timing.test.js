// The match page (route/mnp.js, GET /matches/:key?round=n) ends with timing
// tables. From round 2 on, the last of them totals each team's picking and
// responding over rounds 1 to n (timingTotals in route/mnp.js). The page is
// rendered for real through the route and its templates; the models are
// stand-ins installed in require.cache before the route loads, so nothing
// reads the data folder or the network.
//
// Run with: npm test

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const express = require('express')
const CONST = require('../constants')

const MATCH_KEY = 'mnp-99-1-CPO-SKP'
const AWAY = 'CPO'
const HOME = 'SKP'
const ROUNDS = 4
const GAMES_PER_ROUND = [4, 7, 7, 4]
const MS_PER_SECOND = 1000
const NO_TIME = '—'
const TOTALS_TABLE = 'class="timing timing-totals"'
const ROUND_TABLE = 'class="timing timing-round"'
// A round's steps, in seconds after the round became ready: how long the
// picking team took, then the responding team, then play and both confirms.
// Away picks rounds 1 and 3, home rounds 2 and 4, as the real model orders them.
const T0 = Date.UTC(2026, 0, 5, 3, 0, 0)
const ROUND_GAP_SECONDS = 1800
const STEPS = [
   { pick: 707, respond: 298 },   // round 1: away picks 11:47, home responds 4:58
   { pick: 671, respond: 300 },   // round 2: home picks 11:11, away responds 5:00
   { pick: 707, respond: 298 },   // round 3: away picks 11:47, home responds 4:58
   { pick: 672, respond: 296 }    // round 4: home picks 11:12, away responds 4:56
]
const PLAY_SECONDS = 600
const CONFIRM_SECONDS = 30

let match = null
let server = null
let baseUrl = null


function stub(modulePath, exports) {
   const id = require.resolve(modulePath)
   require.cache[id] = { id, filename: id, loaded: true, exports }
}


function fakeTeam(key) {
   return {
      key: key,
      name: key,
      lineup: [],
      hasCaptain: function() { return false },
      getPermissions: function() { return { canEdit: false } }
   }
}


// Round n's metrics when it began at [ready] and every step finished.
function roundMetrics(n, ready) {
   const step = STEPS[n - 1]
   const picked = ready + step.pick * MS_PER_SECOND
   const responded = picked + step.respond * MS_PER_SECOND
   const completed = responded + PLAY_SECONDS * MS_PER_SECOND
   const confirmed = completed + CONFIRM_SECONDS * MS_PER_SECOND
   return { picked, responded, completed, confirmed: { away: confirmed, home: confirmed } }
}


// A match with what the page reads, with timing for every round up to
// [roundsDone] and the match in [state] at round [round]. Round 1 becomes
// ready when the lineups are confirmed; each later round when the one before
// is confirmed.
function fakeMatch(state, round, roundsDone) {
   const away = fakeTeam(AWAY)
   const home = fakeTeam(HOME)
   const rounds = []
   let ready = T0
   for (let n = 1; n <= ROUNDS; n++) {
      const games = []
      for (let g = 1; g <= GAMES_PER_ROUND[n - 1]; g++) games.push({ n: g })
      const r = { n: n, games: games, done: n <= roundsDone }
      if (n <= roundsDone) {
         r.metrics = roundMetrics(n, ready)
         ready = r.metrics.confirmed.home
      }
      rounds.push(r)
   }
   const noPoints = { away: 0, home: 0, bonus: { away: { participation: 0, handicap: 0 }, home: { participation: 0, handicap: 0 } } }
   return {
      key: MATCH_KEY,
      name: 'CPO @ SKP',
      week: 1,
      round: round,
      state: state,
      state_at: T0,
      venue: { name: 'Test Venue', machines: [] },
      metrics: { set: { away: T0 - 120 * MS_PER_SECOND, home: T0 - 90 * MS_PER_SECOND }, confirm: { away: T0, home: T0 - 30 * MS_PER_SECOND } },
      away: away,
      home: home,
      rounds: rounds,
      players: [],
      getRound: function(n) { return rounds[n - 1] },
      getGame: function(r, n) { return rounds[r - 1].games[n - 1] },
      getOrder: function(n) { return n % 2 == 1 ? [away, home] : [home, away] },
      getPickingTeam: function(n) {
         const order = this.getOrder(n)
         if (this.state === CONST.PICKING) return order[0]
         if (this.state === CONST.RESPONDING) return order[1]
         return null
      },
      getPoints: function() {
         const points = Object.assign({ rounds: [] }, noPoints)
         for (let n = 1; n <= ROUNDS; n++) points.rounds.push({ n: n, away: 0, home: 0 })
         return points
      }
   }
}


before(function(t, done) {
   // The route reads its templates relative to the working directory.
   process.chdir(path.join(__dirname, '..'))
   stub('../model/matches', { get: function(key) { return key === MATCH_KEY ? match : null }, NUM_SCORES: [4, 2, 2, 4, 2] })
   stub('../model/machines', { get: function() { return null } })
   stub('../model/venues', { get: function() { return null } })
   stub('../model/seasons', { get: function() { return { teams: {} } } })
   stub('../model/ratings', { getNames: function() { return [] }, forName: function() { return 1 } })
   stub('../model/players', { get: function() { return null } })
   stub('../model/stats', {})
   stub('../model/suggestions', { getSuggestions: function() { return [] } })
   stub('../lib/score-service', {
      isConfigured: function() { return false },
      isAvailable: function() { return false },
      recognize: function() { throw new Error('not called by the page') }
   })
   const route = require('../route/mnp')
   const app = express()
   app.use(function(req, res, next) {
      req.user = {}
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


// Fetch the match page for round n and return the totals table's rows as
// [team, pick, respond, combined, avgPick, avgRespond], or null if the page
// has no totals table.
async function totalsRows(t, n) {
   t.mock.method(console, 'log', function() {})
   const response = await fetch(baseUrl + '/matches/' + MATCH_KEY + '?round=' + n)
   assert.equal(response.status, 200)
   const html = await response.text()
   const start = html.indexOf(TOTALS_TABLE)
   if (start === -1) return null
   const table = html.slice(start, html.indexOf('</div>', start))
   const rows = []
   const rowPattern = /<span class="timing-team timing-(?:away|home)">(.*?)<\/span>((?:<span class="timing-num timing-(?:away|home)">.*?<\/span>){5})/g
   let m
   while ((m = rowPattern.exec(table)) !== null) {
      const cells = [...m[2].matchAll(/>(.*?)<\/span>/g)].map(function(c) { return c[1] })
      rows.push([m[1]].concat(cells))
   }
   return rows
}


describe('the pick/respond totals table at the bottom of the match page', function() {

   test('on round 4 of a complete match it totals and averages all four rounds', async function(t) {
      match = fakeMatch(CONST.COMPLETE, 4, 4)
      assert.deepEqual(await totalsRows(t, 4), [
         // away picked 11:47 twice (23:34) and responded 5:00 and 4:56 (9:56)
         [AWAY, '23:34', '9:56', '33:30', '11:47', '4:58'],
         // home picked 11:11 and 11:12 (22:23, averaging 11:11.5, shown rounded down) and responded 4:58 twice (9:56)
         [HOME, '22:23', '9:56', '32:19', '11:11', '4:58']
      ])
   })

   test('on round 2 it covers rounds 1 and 2 only', async function(t) {
      match = fakeMatch(CONST.COMPLETE, 4, 4)
      assert.deepEqual(await totalsRows(t, 2), [
         [AWAY, '11:47', '5:00', '16:47', '11:47', '5:00'],
         [HOME, '11:11', '4:58', '16:09', '11:11', '4:58']
      ])
   })

   test('while a response is under way, that step is left out of the totals', async function(t) {
      match = fakeMatch(CONST.RESPONDING, 3, 2)
      const round3 = match.getRound(3)
      // Away has picked round 3; home is still responding.
      round3.metrics = { picked: match.getRound(2).metrics.confirmed.home + STEPS[2].pick * MS_PER_SECOND }
      assert.deepEqual(await totalsRows(t, 3), [
         // picks: 11:47 twice; one response of 5:00
         [AWAY, '23:34', '5:00', '28:34', '11:47', '5:00'],
         // one pick of 11:11; one response of 4:58, the second not finished
         [HOME, '11:11', '4:58', '16:09', '11:11', '4:58']
      ])
   })

   test('a team that has not yet done a step shows a dash for it', async function(t) {
      match = fakeMatch(CONST.PLAYING, 2, 1)
      const round2 = match.getRound(2)
      const ready = match.getRound(1).metrics.confirmed.home
      round2.metrics = { picked: ready + STEPS[1].pick * MS_PER_SECOND, responded: ready + (STEPS[1].pick + STEPS[1].respond) * MS_PER_SECOND }
      assert.deepEqual(await totalsRows(t, 2), [
         [AWAY, '11:47', '5:00', '16:47', '11:47', '5:00'],
         [HOME, '11:11', '4:58', '16:09', '11:11', '4:58']
      ])
      match = fakeMatch(CONST.PLAYING, 2, 1)
      match.getRound(2).metrics = { picked: ready + STEPS[1].pick * MS_PER_SECOND }
      assert.deepEqual(await totalsRows(t, 2), [
         [AWAY, '11:47', NO_TIME, '11:47', '11:47', NO_TIME],
         [HOME, '11:11', '4:58', '16:09', '11:11', '4:58']
      ])
   })

   test('round 1 has no totals table', async function(t) {
      match = fakeMatch(CONST.COMPLETE, 4, 4)
      assert.equal(await totalsRows(t, 1), null)
   })

   test('a round with only its completion and confirmations recorded still gets its table', async function(t) {
      // A match from before pick timing was kept: no lineup times, and round 1
      // has no pick or response time.
      match = fakeMatch(CONST.PLAYING, 2, 1)
      match.metrics = null
      const round1 = match.getRound(1)
      round1.metrics = { completed: round1.metrics.completed, confirmed: round1.metrics.confirmed }
      t.mock.method(console, 'log', function() {})
      const html = await (await fetch(baseUrl + '/matches/' + MATCH_KEY + '?round=1')).text()
      assert.ok(html.includes(ROUND_TABLE), 'round 1 table shown')
      assert.ok(!html.includes(TOTALS_TABLE), 'no totals on round 1')
   })
})
