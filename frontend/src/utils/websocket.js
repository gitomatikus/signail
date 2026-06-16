import config from '../config';

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.subscribers = new Set();
    this.selectedQuestions = new Set();
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.connectionParams = null; // { gameId, hostToken, password } of the active game
  }

  // Connect to a specific game room. Reconnects (manual or automatic) reuse
  // the stored params; connecting to a different game replaces the socket.
  connect(params) {
    if (params) {
      const sameGame = this.connectionParams && this.connectionParams.gameId === params.gameId;
      this.connectionParams = params;
      if (!sameGame && this.ws) {
        // Switching rooms: drop the old socket first
        this.intentionalClose = true;
        this.ws.close();
        this.ws = null;
      }
    }
    if (!this.connectionParams) {
      console.error('WebSocket connect called without game params');
      return;
    }
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

    const { gameId, hostToken, password } = this.connectionParams;
    const query = new URLSearchParams({ gameId });
    if (hostToken) query.set('hostToken', hostToken);
    if (password) query.set('password', password);
    const socket = new WebSocket(`${config.wsUrl}?${query.toString()}`);
    this.ws = socket;

    socket.onopen = () => {
      console.log('WebSocket connected');
      // Let subscribers (re)introduce themselves, e.g. re-send user_login
      this.notifySubscribers({ type: 'ws_open' });
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

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendUserLogin(userData) {
    this.send({ type: 'user_login', data: userData });
  }

  sendUpdateHostProfile(name, imageUrl) {
    this.send({ type: 'update_host_profile', data: { name, imageUrl } });
  }

  sendUserLogout(userData) {
    this.send({ type: 'user_logout', data: userData });
  }

  sendStartGame() {
    this.send({ type: 'start_game' });
  }

  sendQuestionSelect(questionId, userType, userId = null) {
    this.send({ type: 'question_select', data: { questionId, userType, userId } });
  }

  sendQuestionToggle(questionId) {
    this.send({ type: 'question_toggle', data: { questionId } });
  }

  sendCatClicks(questionId, userId, clicksLeft) {
    this.send({ type: 'cat_clicks', data: { questionId, userId, clicksLeft } });
  }

  sendCatClicksGrant(questionId, userId, amount = 1) {
    this.send({ type: 'cat_clicks_grant', data: { questionId, userId, amount } });
  }

  sendNumberAnswer(questionId, userId, value) {
    this.send({ type: 'number_answer', data: { questionId, userId, value } });
  }

  sendRevealNumberAnswers(questionId) {
    this.send({ type: 'reveal_number_answers', data: { questionId } });
  }

  sendSecretAssign(questionId, targetUserId, selectorUserId = null) {
    this.send({ type: 'secret_assign', data: { questionId, targetUserId, selectorUserId } });
  }

  sendKaraokeAssign(questionId, targetUserId, selectorUserId = null) {
    this.send({ type: 'karaoke_assign', data: { questionId, targetUserId, selectorUserId } });
  }

  sendKaraokeStart(questionId, performanceId, durationMs) {
    this.send({ type: 'karaoke_start', data: { questionId, performanceId, durationMs } });
  }

  sendKaraokeChunk(questionId, performanceId, chunk) {
    this.send({ type: 'karaoke_chunk', data: { questionId, performanceId, ...chunk } });
  }

  sendKaraokeEnd(questionId, performanceId) {
    this.send({ type: 'karaoke_end', data: { questionId, performanceId } });
  }

  sendKaraokeSync(questionId) {
    this.send({ type: 'karaoke_sync', data: { questionId } });
  }

  sendCrocodileAssign(questionId, targetUserId, selectorUserId = null) {
    this.send({ type: 'crocodile_assign', data: { questionId, targetUserId, selectorUserId } });
  }

  sendCrocodileResponse(questionId, value) {
    this.send({ type: 'crocodile_response', data: { questionId, value } });
  }

  sendCastVote(questionId, voterId, targetUserId) {
    this.send({ type: 'cast_vote', data: { questionId, voterId, targetUserId } });
  }

  sendRevealVotes(questionId) {
    this.send({ type: 'reveal_votes', data: { questionId } });
  }

  sendClearSelectedQuestions() {
    this.send({ type: 'clear_selected_questions' });
  }

  sendClearCache() {
    this.send({ type: 'clear_cache' });
  }

  sendUpdateScore(userId, score) {
    this.send({ type: 'update_score', data: { userId, score } });
  }

  sendAdminClickedGreenNumber(userId) {
    this.send({ type: 'admin_clicked_green_number', data: { userId } });
  }

  sendAdminClickedRedNumber(userId) {
    this.send({ type: 'admin_clicked_red_number', data: { userId } });
  }

  getSelectedQuestions() {
    return this.selectedQuestions;
  }

  sendQuestionReveal(questionId) {
    this.send({ type: 'question_reveal', data: { questionId } });
  }

  sendAnswerReveal(questionId) {
    this.send({ type: 'answer_reveal', data: { questionId } });
  }

  sendResponseReveal(questionId) {
    this.send({ type: 'response_reveal', data: { questionId } });
  }

  sendElapsedTime(questionId, elapsedTime, userId) {
    this.send({ type: 'elapsed_time', data: { questionId, elapsedTime, userId } });
  }

  sendReturnToGame() {
    this.send({ type: 'return_to_game' });
  }

  sendMediaControl(questionId, control) {
    this.send({ type: 'media_control', data: { questionId, ...control } });
  }

  sendRoundChange(roundIndex) {
    this.send({ type: 'round_change', data: { roundIndex } });
  }

  sendRequestSelectedQuestions() {
    this.send({ type: 'request_selected_questions' });
  }

  disconnect() {
    this.intentionalClose = true;
    this.connectionParams = null;
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
