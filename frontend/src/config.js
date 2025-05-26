const config = {
  // Default to localhost:8000 if not specified
  wsUrl: process.env.REACT_APP_WS_URL || 'ws://localhost:8000/ws',
  apiUrl: process.env.REACT_APP_API_URL || 'http://localhost:8000'
};

export default config; 