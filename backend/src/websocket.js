const WebSocket = require('ws');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.onlineUsers = new Map(); // Map of user data by WebSocket connection
    this.persistentUsers = new Map(); // Map of user data by userId
  }

  initialize(server) {
    this.wss = new WebSocket.Server({ server });

    this.wss.on('connection', (ws) => {
      console.log('New client connected');

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          
          if (data.type === 'user_login') {
            const userData = data.data;
            // Generate a unique ID for the user if not present
            if (!userData.id) {
              userData.id = `${userData.name}-${Date.now()}`;
            }
            // Ensure score is present
            if (typeof userData.score !== 'number') {
              userData.score = 0;
            }
            // Store user data with their WebSocket connection
            this.onlineUsers.set(ws, userData);
            // Store user data in persistent storage
            this.persistentUsers.set(userData.id, userData);
            // Broadcast updated user list to all clients
            this.broadcastOnlineUsers();
          } else if (data.type === 'user_logout') {
            const userData = data.data;
            // Remove user from both maps
            this.onlineUsers.delete(ws);
            this.persistentUsers.delete(userData.id);
            // Broadcast updated user list to all clients
            this.broadcastOnlineUsers();
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      ws.on('close', () => {
        // Get user data before removing the connection
        const userData = this.onlineUsers.get(ws);
        if (userData) {
          // Remove from WebSocket connection map
          this.onlineUsers.delete(ws);
          // Remove from persistent storage
          this.persistentUsers.delete(userData.id);
          // Broadcast updated user list to all clients
          this.broadcastOnlineUsers();
        }
      });
    });
  }

  broadcastOnlineUsers() {
    const users = Array.from(this.persistentUsers.values());
    const message = JSON.stringify({
      type: 'online_users',
      data: users
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  getOnlineUsers() {
    return Array.from(this.persistentUsers.values());
  }
}

// Create a singleton instance
const wsManager = new WebSocketManager();
module.exports = wsManager; 