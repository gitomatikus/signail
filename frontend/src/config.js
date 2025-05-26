const config = {
  // Backend API and WebSocket are on port 8000, frontend runs on 3001
  wsUrl: process.env.REACT_APP_WS_URL || 'ws://localhost:8000/ws',
  apiUrl: process.env.REACT_APP_API_URL || 'http://localhost:8000'
};

export default config; 