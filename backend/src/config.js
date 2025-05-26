require('dotenv').config();

const config = {
  port: process.env.PORT || 8000,
  wsPath: process.env.WS_PATH || '/ws',
  corsOrigin: process.env.CORS_ORIGIN || '*'
};

module.exports = config; 