// Tests for the player-name helpers in lib/util.js.
// Run with: node tests/names.test.js

const assert = require('node:assert')
const util = require('../lib/util')

const NBSP = ' '


function testNormalizeName() {
   // The three cases from the bug: space before, after, and doubled inside.
   assert.strictEqual(util.normalizeName(' Bad name'), 'Bad name')
   assert.strictEqual(util.normalizeName('Bad name '), 'Bad name')
   assert.strictEqual(util.normalizeName('Bad  name'), 'Bad name')

   assert.strictEqual(util.normalizeName('  Bad   name  '), 'Bad name')
   assert.strictEqual(util.normalizeName('Bad name'), 'Bad name')
   assert.strictEqual(util.normalizeName('Mary  Ann   van  Dyke'), 'Mary Ann van Dyke')

   // Tabs, newlines and non-breaking spaces (pasted names) count as whitespace.
   assert.strictEqual(util.normalizeName('\tBad\tname\n'), 'Bad name')
   assert.strictEqual(util.normalizeName('Bad' + NBSP + NBSP + 'name' + NBSP), 'Bad name')
   assert.strictEqual(util.normalizeName('Bad \r\n name'), 'Bad name')

   // Case and punctuation are left alone.
   assert.strictEqual(util.normalizeName("  D'juan  McDonald-Smith "), "D'juan McDonald-Smith")

   // Nothing, or only whitespace, becomes the empty string.
   assert.strictEqual(util.normalizeName(''), '')
   assert.strictEqual(util.normalizeName('   '), '')
   assert.strictEqual(util.normalizeName(undefined), '')
   assert.strictEqual(util.normalizeName(null), '')
}


function testNameKeyAndSameName() {
   assert.strictEqual(util.nameKey('  Bad   NAME '), 'bad name')
   assert.strictEqual(util.nameKey('Bad name'), util.nameKey('bad  NAME'))

   assert.ok(util.sameName('Bad name', 'bad name'))
   assert.ok(util.sameName('Bad name', ' BAD   Name '))
   assert.ok(util.sameName('Bad' + NBSP + 'name', 'Bad name'))
   assert.ok(!util.sameName('Bad name', 'Badname'))
   assert.ok(!util.sameName('Bad name', 'Bad names'))
   assert.ok(!util.sameName('Bad name', undefined))
}


function testCompareNames() {
   // Capitals no longer sort ahead of lower case.
   const sorted = ['Zed Zulu', 'de Vries', 'Abe Able', 'abe  baker'].sort(util.compareNames)
   assert.deepStrictEqual(sorted, ['Abe Able', 'abe  baker', 'de Vries', 'Zed Zulu'])

   assert.strictEqual(util.compareNames('Bad name', ' bad  NAME'), 0)
   assert.ok(util.compareNames('Abe', 'Zed') < 0)
   assert.ok(util.compareNames('zed', 'Abe') > 0)
}


testNormalizeName()
testNameKeyAndSameName()
testCompareNames()
console.log('names: all tests passed')
