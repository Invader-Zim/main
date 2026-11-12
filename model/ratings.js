const fs = require('fs');
const util = require('../lib/util');
const DATA_FOLDER = require('../config').DATA_FOLDER

// Rows of [ipr, name]. Names are tidied as they come in from the file, since
// they feed the add-player suggestions.
const csv = fs.readFileSync(DATA_FOLDER + '/IPR.csv')
  .toString()
  .split('\n')
  .filter(line => line.length > 0)
  .map(line => line.split(','))
  .map(row => {
    row[1] = util.normalizeName(row[1]);
    return row;
  });

// Ratings are looked up by name without regard to case or spacing.
const map = csv.reduce((m, row) => {
  const [ ipr, name ] = row;
  m[util.nameKey(name)] = parseInt(ipr);
  return m;
}, {});

module.exports = {
  forName: name => name ? (map[util.nameKey(name)] || 0) : 0,
  getNames: () => csv.map(row => row[1])
};
