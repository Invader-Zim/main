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

module.exports = {
  copy: copy,
  digest: digest,
  fileExists: fileExists,
  isEmail: isEmail,
  isBannedEmail: isBannedEmail
};
