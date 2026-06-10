import config from '../config';

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.subscribers = new Set();
    this.selectedQuestions = new Set();
    this.reconnectTimer = null;
    this.intentionalClose = false;
  }

  connect() {
    // Never open a second socket: a duplicate connection means every
    // broadcast is delivered (and applied) twice
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.intentionalClose = false;

    const socket = new WebSocket(config.wsUrl);
    this.ws = socket;

    socket.onopen = () => {
      console.log('WebSocket connected');
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) {
        return; // stale socket that was replaced - ignore its messages
      }
      const data = JSON.parse(event.data);
      this.notifySubscribers(data);
    };

    socket.onclose = () => {
      console.log('WebSocket disconnected');
      if (this.ws !== socket || this.intentionalClose) {
        return; // replaced or deliberately closed - no auto-reconnect
      }
      // Attempt to reconnect after 5 seconds
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    };

    socket.onerror = (error) => {
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

  sendQuestionSelect(questionId, userType, userId = null) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'question_select',
        data: { questionId, userType, userId }
      }));
    }
  }

  sendCatClicks(questionId, userId, clicksLeft) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'cat_clicks',
        data: { questionId, userId, clicksLeft }
      }));
    }
  }

  sendCatClicksGrant(questionId, userId, amount = 1) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'cat_clicks_grant',
        data: { questionId, userId, amount }
      }));
    }
  }

  sendNumberAnswer(questionId, userId, value) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'number_answer',
        data: { questionId, userId, value }
      }));
    }
  }

  sendRevealNumberAnswers(questionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'reveal_number_answers',
        data: { questionId }
      }));
    }
  }

  sendSecretAssign(questionId, targetUserId, selectorUserId = null) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'secret_assign',
        data: { questionId, targetUserId, selectorUserId }
      }));
    }
  }

  sendClearSelectedQuestions() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'clear_selected_questions'
      }));
    }
  }

  sendClearCache() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'clear_cache'
      }));
    }
  }

  getSelectedQuestions() {
    return this.selectedQuestions;
  }

  handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'selected_questions_update') {
        this.selectedQuestions = new Set(data.data);
        // Notify subscribers about the update
        this.notifySubscribers(data);
      } else if (data.type === 'return_to_game') {
        // When returning to game, request an update of selected questions
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'request_selected_questions'
          }));
        }
        this.notifySubscribers(data);
      } else {
        // Notify subscribers for other message types
        this.notifySubscribers(data);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  sendQuestionReveal(questionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'question_reveal',
        data: {
          questionId
        }
      }));
    }
  }

  sendAnswerReveal(questionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'answer_reveal',
        data: {
          questionId
        }
      }));
    }
  }

  sendResponseReveal(questionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'response_reveal',
        data: {
          questionId
        }
      }));
    }
  }

  sendElapsedTime(questionId, elapsedTime, userId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'elapsed_time',
        data: {
          questionId,
          elapsedTime,
          userId
        }
      }));
    }
  }

  sendReturnToGame() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'return_to_game'
      }));
    }
  }

  sendMediaControl(questionId, control) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'media_control',
        data: { questionId, ...control }
      }));
    }
  }

  sendRoundChange(roundIndex) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'round_change',
        data: {
          roundIndex
        }
      }));
    }
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Create a singleton instance
const wsManager = new WebSocketManager();
export default wsManager; 