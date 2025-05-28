import config from '../config';

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.subscribers = new Set();
    this.selectedQuestions = new Set();
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

  sendQuestionSelect(questionId, userType) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'question_select',
        data: { questionId, userType }
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
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Create a singleton instance
const wsManager = new WebSocketManager();
export default wsManager; 