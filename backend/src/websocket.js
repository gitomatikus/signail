const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('./config');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.cacheKey = crypto.randomUUID(); // Rotated on pack upload / clear cache; clients drop local caches when it changes
    this.onlineUsers = new Map(); // Map of user data by WebSocket connection
    this.persistentUsers = new Map(); // Map of user data by userId
    this.userScores = new Map(); // Map of score by userId (persisted across reloads/disconnections)
    this.selectedQuestions = new Set(); // Track selected questions
    this.revealedQuestions = new Set(); // Track questions revealed by the admin
    this.questionTimes = new Map(); // Map of question ID to user times
    this.questionClicks = new Map(); // Map of question ID to Map of userId -> clicks left (find-a-cat)
    this.questionAnswers = new Map(); // Map of question ID to Map of userId -> submitted number (close-enough)
    this.revealedAnswers = new Set(); // Close-enough questions whose numbers were revealed
    this.questionSelectors = new Map(); // Map of question ID to userId who selected it
    this.secretAssignments = new Map(); // Map of question ID to { targetUserId, selectorUserId }
    this.lastGreenFrameUser = null; // Track the last user with green frame
  }

  initialize(server) {
    this.wss = new WebSocket.Server({ server, path: config.wsPath });

    // Send current selected questions to new client
    this.wss.on('connection', (ws, req) => {
      const requestOrigin = req?.headers?.origin;
      console.log(`New client connected${requestOrigin ? ` from ${requestOrigin}` : ''}`);
      ws.send(JSON.stringify({
        type: 'selected_questions_update',
        data: Array.from(this.selectedQuestions)
      }));
      // Give every client the current cache key on connect so it can
      // compare against the one saved in localStorage
      ws.send(JSON.stringify({
        type: 'cache_key_update',
        data: { cacheKey: this.cacheKey }
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
            // Restore score if user is reconnecting, otherwise initialize
            if (this.userScores.has(userData.id)) {
              userData.score = this.userScores.get(userData.id);
            } else {
              if (typeof userData.score !== 'number') {
                userData.score = 0;
              }
              this.userScores.set(userData.id, userData.score);
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
            const { questionId, userId } = data.data;
            // Remember who selected the question (needed for cat-in-the-bag).
            // Fall back to the green-frame player: they own the move even when
            // the admin clicks the question on their behalf.
            const selectorId = userId || this.lastGreenFrameUser;
            if (selectorId) {
              this.questionSelectors.set(questionId, selectorId);
            }
            // Add question to selected questions set
            this.selectedQuestions.add(questionId);
            // Broadcast question selection to all clients
            this.broadcastQuestionSelect(data.data);
            // Broadcast updated selected questions to all clients
            this.broadcastSelectedQuestions();
          } else if (data.type === 'question_reveal') {
            // Remember the reveal so refreshing clients can restore it
            this.revealedQuestions.add(data.data.questionId);
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
          } else if (data.type === 'admin_clicked_red_number') {
            // Log the user ID when admin clicks red number
            console.log('Admin clicked red number for user ID:', data.data.userId);
            // Broadcast the event to all clients
            this.broadcastAdminClickedRedNumber(data.data);
          } else if (data.type === 'admin_clicked_green_number') {
            // Log the user ID when admin clicks green number
            console.log('Admin clicked green number for user ID:', data.data.userId);
            // Broadcast the event to all clients
            this.broadcastAdminClickedGreenNumber(data.data);
          } else if (data.type === 'cat_clicks') {
            // Player reports their remaining clicks for a find-a-cat question
            const { questionId, userId, clicksLeft } = data.data;
            if (userId && Number.isFinite(Number(clicksLeft))) {
              if (!this.questionClicks.has(questionId)) {
                this.questionClicks.set(questionId, new Map());
              }
              this.questionClicks.get(questionId).set(userId, Number(clicksLeft));
              this.broadcastToAll({ type: 'cat_clicks', data: { questionId, userId, clicksLeft: Number(clicksLeft) } });
            }
          } else if (data.type === 'cat_clicks_grant') {
            // Admin grants extra clicks to a player. Each grant carries a unique
            // id so clients can never apply the same grant twice.
            const { questionId, userId, amount } = data.data;
            const numericAmount = Number(amount);
            if (userId && Number.isFinite(numericAmount) && numericAmount > 0) {
              const clicks = this.questionClicks.get(questionId);
              if (clicks && clicks.has(userId)) {
                clicks.set(userId, clicks.get(userId) + numericAmount);
              }
              this.broadcastToAll({
                type: 'cat_clicks_grant',
                data: { questionId, userId, amount: numericAmount, grantId: crypto.randomUUID() }
              });
            }
          } else if (data.type === 'number_answer') {
            // Player submits an answer: a number (close-enough), an array of
            // option indices (choice) or a text/pasted-image string (text-answer).
            // One submission per user; nothing accepted after the reveal.
            const { questionId, userId, value } = data.data;
            if (userId && this.isValidAnswerValue(value) && !this.revealedAnswers.has(questionId)) {
              if (!this.questionAnswers.has(questionId)) {
                this.questionAnswers.set(questionId, new Map());
              }
              const answers = this.questionAnswers.get(questionId);
              if (!answers.has(userId)) {
                answers.set(userId, value);
                // Choice picks go out unmasked so the admin sees results in
                // real time; for other types clients only learn that the
                // player answered, not the answer itself
                const isChoice = typeof this.getQuestionType === 'function'
                  && this.getQuestionType(questionId) === 'choice';
                this.broadcastToAll({
                  type: 'number_answer_submitted',
                  data: isChoice ? { questionId, userId, value } : { questionId, userId }
                });
              }
            }
          } else if (data.type === 'reveal_number_answers') {
            // Admin ends the submission window: stop accepting and show all numbers
            const { questionId } = data.data;
            if (!this.revealedAnswers.has(questionId)) {
              this.revealedAnswers.add(questionId);
              const answers = this.questionAnswers.get(questionId) || new Map();
              this.broadcastToAll({
                type: 'number_answers',
                data: { questionId, answers: Object.fromEntries(answers) }
              });
            }
          } else if (data.type === 'secret_assign') {
            const { questionId, targetUserId, selectorUserId } = data.data;
            // First assignment wins; ignore duplicates/races
            if (!this.secretAssignments.has(questionId) && targetUserId) {
              this.secretAssignments.set(questionId, { targetUserId, selectorUserId: selectorUserId || null });
              this.broadcastSecretAssign({
                questionId,
                targetUserId,
                selectorUserId: selectorUserId || null
              });
            }
          } else if (data.type === 'request_selected_questions') {
            // Send current selected questions to the requesting client
            ws.send(JSON.stringify({
              type: 'selected_questions_update',
              data: Array.from(this.selectedQuestions)
            }));
          } else if (data.type === 'clear_cache') {
            // Clear all per-question state
            this.resetQuestionState();
            // Reset all user scores
            this.persistentUsers.forEach(userData => {
              userData.score = 0;
            });
            this.userScores.clear(); // Clear all saved scores
            // Broadcast updated user list to all clients
            this.broadcastOnlineUsers();
            // Rotate the cache key so every client drops its local cache
            this.regenerateCacheKey();
          } else if (data.type === 'update_score') {
            const { userId, score } = data.data;
            const userData = this.persistentUsers.get(userId);
            if (userData) {
              const numericScore = Number(score);
              if (!Number.isFinite(numericScore)) {
                console.warn(`Ignored invalid score value for user ${userId}:`, score);
                return;
              }
              userData.score = numericScore;
              this.persistentUsers.set(userId, userData);
              this.userScores.set(userId, numericScore); // Persist score
              // Broadcast updated user list to all clients
              this.broadcastOnlineUsers();
            }
          } else if (data.type === 'round_change') {
            // Broadcast round change to all clients
            this.broadcastRoundChange(data.data);
          } else if (data.type === 'media_control') {
            // Admin drives question audio/video for everyone: relay play/pause/seek
            const { questionId, action, time, mediaIndex, src } = data.data || {};
            if (questionId !== undefined && ['play', 'pause', 'seek'].includes(action)) {
              this.broadcastToAll({
                type: 'media_control',
                data: { questionId, action, time, mediaIndex, src }
              });
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

  broadcastRoundChange(data) {
    const message = JSON.stringify({
      type: 'round_change',
      data: data
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastAdminClickedRedNumber(data) {
    const message = JSON.stringify({
      type: 'admin_clicked_red_number',
      data: data
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastAdminClickedGreenNumber(data) {
    // Update the last user with green frame
    this.lastGreenFrameUser = data.userId;
    
    const message = JSON.stringify({
      type: 'admin_clicked_green_number',
      data: data
    });

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastToAll(payload) {
    const message = JSON.stringify(payload);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastSecretAssign(data) {
    const message = JSON.stringify({
      type: 'secret_assign',
      data: data
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

  getCacheKey() {
    return this.cacheKey;
  }

  // Generate a fresh cache key and tell every connected client about it,
  // so they invalidate their local caches immediately
  regenerateCacheKey() {
    this.cacheKey = crypto.randomUUID();
    this.broadcastToAll({
      type: 'cache_key_update',
      data: { cacheKey: this.cacheKey }
    });
    return this.cacheKey;
  }

  // Clear all per-question state (selections, reveals, times, clicks, answers).
  // User scores are handled separately - a new pack shouldn't necessarily wipe them.
  resetQuestionState() {
    this.selectedQuestions.clear();
    this.revealedQuestions.clear();
    this.clearAllQuestionTimes();
    this.questionSelectors.clear();
    this.secretAssignments.clear();
    this.questionClicks.clear();
    this.questionAnswers.clear();
    this.revealedAnswers.clear();
    this.broadcastSelectedQuestions();
  }

  // Get cat-in-the-bag state for a specific question (selector + assignment + reveal)
  getSecretInfo(questionId) {
    return {
      selectorId: this.questionSelectors.get(questionId) || null,
      assignment: this.secretAssignments.get(questionId) || null,
      revealed: this.revealedQuestions.has(questionId)
    };
  }

  // Add method to get times for a specific question
  getQuestionTimes(questionId) {
    return this.questionTimes.get(questionId) || new Map();
  }

  // Get remaining find-a-cat clicks for a specific question
  getQuestionClicks(questionId) {
    return this.questionClicks.get(questionId) || new Map();
  }

  // Accepted submission shapes: finite number (close-enough), non-empty
  // array of option indices (choice), non-empty string up to ~8MB so a
  // pasted screenshot data-URL fits (text-answer)
  isValidAnswerValue(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    if (typeof value === 'string') {
      return value.length > 0 && value.length <= 8000000;
    }
    if (Array.isArray(value)) {
      return value.length > 0 && value.length <= 100 && value.every(v => Number.isFinite(Number(v)));
    }
    return false;
  }

  // Get close-enough submissions for a specific question
  getNumberAnswersInfo(questionId) {
    return {
      revealed: this.revealedAnswers.has(questionId),
      answers: this.questionAnswers.get(questionId) || new Map()
    };
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

  // Add method to get the last user with green frame
  getLastGreenFrameUser() {
    return this.lastGreenFrameUser;
  }

  // Add method to clear the last green frame user
  clearLastGreenFrameUser() {
    this.lastGreenFrameUser = null;
  }
}

// Create a singleton instance
const wsManager = new WebSocketManager();
module.exports = wsManager; 
