require('dotenv').load();

const config = {
  CREDENTIALS_FOLDER: process.env.CREDENTIALS_FOLDER ||  __dirname + '/credentials',
  DATA_FOLDER: process.env.DATA_FOLDER || __dirname + '/data',
  UPLOADS_FOLDER: process.env.UPLOADS_FOLDER || __dirname + '/data/uploads',
  CURRENT_SEASON: process.env.CURRENT_SEASON || 'season-14',
  NUM_WEEKS: process.env.NUM_WEEKS || 10,
  ANNOUNCEMENTS_TEMPLATE_URL: process.env.ANNOUNCEMENTS_TEMPLATE_URL || 'https://raw.githubusercontent.com/Invader-Zim/mnp-announcements/main/index.html',
  CREDENTIALS_FOLDER: process.env.CREDENTIALS_FOLDER || './credentials',
  IFPA_API_KEY: process.env.IFPA_API_KEY,
  EMAIL_HOST: process.env.EMAIL_HOST,
  EMAIL_PORT: process.env.EMAIL_PORT,
  EMAIL_NAME: process.env.EMAIL_NAME,
  EMAIL_ADDRESS: process.env.EMAIL_ADDRESS,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  LEAGUE_ADMINS: (process.env.LEAGUE_ADMINS || "admin").split(',')
};

module.exports = config;
