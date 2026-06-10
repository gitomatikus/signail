require('dotenv').config();

// "*" allows every origin; otherwise a comma-separated list of allowed origins
const corsOrigin = process.env.CORS_ORIGIN || '*';
const allowAllOrigins = corsOrigin === '*';

const config = {
  port: process.env.PORT || 8000,
  wsPath: process.env.WS_PATH || '/ws',
  allowAllOrigins,
  corsOrigins: allowAllOrigins
    ? ['*']
    : corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean)
};

module.exports = config;
