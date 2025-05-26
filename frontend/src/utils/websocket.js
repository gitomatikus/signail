import config from '../config';

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.subscribers = new Set();
  }

  connect() {
    this.ws = new WebSocket(config.wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.notifySubscribers(data);
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Attempt to reconnect after 5 seconds
      setTimeout(() => this.connect(), 5000);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notifySubscribers(data) {
    this.subscribers.forEach(callback => callback(data));
  }

  sendUserLogin(userData) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'user_login',
        data: userData
      }));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Create a singleton instance
const wsManager = new WebSocketManager();
export default wsManager; 