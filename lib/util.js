var fs = require('fs');
var crypto = require('crypto');

// TODO Replace with Object.assign, although maybe need something else.
function copy(src,dst,exclude) {
  for(prop in src) {
    if(!exclude || !(exclude.indexOf(prop) >= 0)) {
      dst[prop] = src[prop];
    }
  }
}

function digest(raw) {
  var shasum = crypto.createHash('sha1');
  shasum.update(raw);
  return shasum.digest('hex');
}

function fileExists(filename) {
  try {
    fs.statSync(filename);
    return true;
  } catch(e) {}
  return false;
}

function isEmail(raw) {
  if(!raw) return false;
  if(raw.length < 5) return false;
  if(raw.indexOf('@') < 0) return false;

  //TODO: Find and use a email regex here.
  return true;
}

function isBannedEmail(raw) {
  if(!isEmail(raw)) return true;
  if(raw.substr(-3) === ".ru") return true;
  if(raw.substr(-3) === ".de") return true;
  return false;
}

//Player names: every place that takes in a new name normalizes it first, and
//every name comparison goes through nameKey, sameName or compareNames.

//A name with no whitespace at either end and single spaces inside (tabs,
//newlines and non-breaking spaces count as whitespace).
function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

//What names are compared by: normalized, and without regard to case.
function nameKey(name) {
  return normalizeName(name).toLowerCase();
}

function sameName(a, b) {
  return nameKey(a) === nameKey(b);
}

//Sort order for names, without regard to case.
function compareNames(a, b) {
  var x = nameKey(a);
  var y = nameKey(b);
  return x < y ? -1 : (x > y ? 1 : 0);
}

module.exports = {
  copy: copy,
  digest: digest,
  fileExists: fileExists,
  isEmail: isEmail,
  isBannedEmail: isBannedEmail,
  normalizeName: normalizeName,
  nameKey: nameKey,
  sameName: sameName,
  compareNames: compareNames
};
