const WebSocket = require('ws');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.onlineUsers = new Map(); // Map of user data by WebSocket connection
    this.persistentUsers = new Map(); // Map of user data by userId
    this.selectedQuestions = new Set(); // Track selected questions
    this.questionTimes = new Map(); // Map of question ID to user times
  }

  initialize(server) {
    this.wss = new WebSocket.Server({ server });

    // Send current selected questions to new client
    this.wss.on('connection', (ws) => {
      console.log('New client connected');
      ws.send(JSON.stringify({
        type: 'selected_questions_update',
        data: Array.from(this.selectedQuestions)
      }));

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
          } else if (data.type === 'question_select') {
            const { questionId } = data.data;
            // Add question to selected questions set
            this.selectedQuestions.add(questionId);
            // Broadcast question selection to all clients
            this.broadcastQuestionSelect(data.data);
            // Broadcast updated selected questions to all clients
            this.broadcastSelectedQuestions();
          } else if (data.type === 'question_reveal') {
            // Broadcast question reveal to all clients
            this.broadcastQuestionReveal(data.data);
          } else if (data.type === 'answer_reveal') {
            // Broadcast answer reveal to all clients
            this.broadcastAnswerReveal(data.data);
          } else if (data.type === 'response_reveal') {
            // Broadcast response reveal to all clients
            this.broadcastResponseReveal(data.data);
          } else if (data.type === 'return_to_game') {
            // Broadcast return to game to all clients
            this.broadcastReturnToGame();
          } else if (data.type === 'elapsed_time') {
            // Broadcast elapsed time to all clients
            this.broadcastElapsedTime(data.data);
          } else if (data.type === 'clear_selected_questions') {
            // Clear selected questions
            this.selectedQuestions.clear();
            // Broadcast updated selected questions to all clients
            this.broadcastSelectedQuestions();
          } else if (data.type === 'request_selected_questions') {
            // Send current selected questions to the requesting client
            ws.send(JSON.stringify({
              type: 'selected_questions_update',
              data: Array.from(this.selectedQuestions)
            }));
          } else if (data.type === 'clear_cache') {
            // Clear selected questions
            this.selectedQuestions.clear();
            // Clear all question times
            this.clearAllQuestionTimes();
            // Reset all user scores
            this.persistentUsers.forEach(userData => {
              userData.score = 0;
            });
            // Broadcast updated selected questions to all clients
            this.broadcastSelectedQuestions();
            // Broadcast updated user list to all clients
            this.broadcastOnlineUsers();
          } else if (data.type === 'update_score') {
            const { userId, score } = data.data;
            const userData = this.persistentUsers.get(userId);
            if (userData) {
              userData.score = score;
              this.persistentUsers.set(userId, userData);
              // Broadcast updated user list to all clients
              this.broadcastOnlineUsers();
            }
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

  broadcastQuestionSelect(questionData) {
    const message = JSON.stringify({
      type: 'question_select',
      data: questionData
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastQuestionReveal(questionData) {
    const message = JSON.stringify({
      type: 'question_reveal',
      data: questionData
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastAnswerReveal(questionData) {
    const message = JSON.stringify({
      type: 'answer_reveal',
      data: questionData
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastResponseReveal(questionData) {
    const message = JSON.stringify({
      type: 'response_reveal',
      data: questionData
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastReturnToGame() {
    const message = JSON.stringify({
      type: 'return_to_game'
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastSelectedQuestions() {
    if (!this.wss) return;
    
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'selected_questions_update',
          data: Array.from(this.selectedQuestions)
        }));
      }
    });
  }

  broadcastElapsedTime(data) {
    const { questionId, elapsedTime, userId } = data;
    
    // Store the time in memory
    if (!this.questionTimes.has(questionId)) {
      this.questionTimes.set(questionId, new Map());
    }
    
    // Only store the time if the user doesn't already have one
    const questionTimes = this.questionTimes.get(questionId);
    if (!questionTimes.has(userId)) {
      questionTimes.set(userId, elapsedTime);

      const message = JSON.stringify({
        type: 'elapsed_time',
        data: data
      });

      this.wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  }

  getOnlineUsers() {
    return Array.from(this.persistentUsers.values());
  }

  // Add method to get times for a specific question
  getQuestionTimes(questionId) {
    return this.questionTimes.get(questionId) || new Map();
  }

  // Add method to clear times for a specific question
  clearQuestionTimes(questionId) {
    this.questionTimes.delete(questionId);
  }

  // Add method to clear all question times
  clearAllQuestionTimes() {
    this.questionTimes.clear();
    // Broadcast the clear times event to all clients
    const message = JSON.stringify({
      type: 'clear_question_times'
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

// Create a singleton instance
const wsManager = new WebSocketManager();
module.exports = wsManager; 