import config from '../config';

// Client-side liveness check. Browsers do NOT reliably fire onclose/onerror for
// a half-open socket (Wi-Fi switch, sleep, backgrounded tab, proxy hiccup), so
// without an app-level heartbeat the client thinks it is still connected and
// never reconnects - the user has to refresh. We ping every PING_INTERVAL_MS;
// if no pong comes back within PONG_TIMEOUT_MS the socket is treated as dead.
const PING_INTERVAL_MS = 10000;
const PONG_TIMEOUT_MS = 10000;

// Reconnect cadence: start near-immediate and back off exponentially up to a
// cap, with jitter so a crowd of clients doesn't reconnect in lockstep after a
// server blip. Mirrors Socket.IO's defaults (fast first retry is what makes
// reconnection feel instant). The counter resets to 0 on a successful open.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;
const RECONNECT_JITTER = 0.5;

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.subscribers = new Set();
    this.selectedQuestions = new Set();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.intentionalClose = false;
    this.connectionParams = null; // { gameId, hostToken, password } of the active game

    // A device waking up (tab refocus, network back) is the moment a half-open
    // socket needs to be re-checked / replaced - probe or reconnect immediately
    // instead of waiting out the next ping interval.
    if (typeof window !== 'undefined') {
      const wake = () => this.handleNetworkWake();
      window.addEventListener('online', wake);
      window.addEventListener('focus', wake);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') wake();
        });
      }
    }
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
        this.stopHeartbeat();
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
      this.reconnectAttempts = 0; // fresh connection: reset the backoff
      this.startHeartbeat();
      // Let subscribers (re)introduce themselves, e.g. re-send user_login
      this.notifySubscribers({ type: 'ws_open' });
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) {
        return; // stale socket that was replaced - ignore its messages
      }
      const data = JSON.parse(event.data);
      if (data.type === 'pong') {
        // The socket is alive: cancel the pending dead-connection timeout
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        return;
      }
      this.notifySubscribers(data);
    };

    socket.onclose = () => {
      console.log('WebSocket disconnected');
      if (this.ws !== socket || this.intentionalClose) {
        return; // replaced or deliberately closed - no auto-reconnect
      }
      this.stopHeartbeat();
      // Tell the UI we're offline so it can show a "reconnecting" indicator
      this.notifySubscribers({ type: 'ws_closed' });
      this.scheduleReconnect();
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ type: 'ping' }));
    if (this.pongTimer) {
      return; // already awaiting a pong; one outstanding probe is enough
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // No pong in time: the connection is half-open. Drop it (ignoring its
      // late onclose) and reconnect immediately.
      const dead = this.ws;
      this.ws = null;
      if (dead) {
        try { dead.close(); } catch (e) { /* already closing */ }
      }
      this.notifySubscribers({ type: 'ws_closed' }); // half-open: tell the UI
      this.reconnectNow();
    }, PONG_TIMEOUT_MS);
  }

  // Backoff between reconnect attempts: RECONNECT_BASE_MS * 2^attempts, jittered
  // by +/-RECONNECT_JITTER and clamped to RECONNECT_MAX_MS.
  scheduleReconnect() {
    if (this.intentionalClose || !this.connectionParams || this.reconnectTimer) {
      return;
    }
    const raw = RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts);
    const deviation = raw * RECONNECT_JITTER * Math.random();
    const jittered = Math.random() < 0.5 ? raw - deviation : raw + deviation;
    const delay = Math.max(0, Math.min(RECONNECT_MAX_MS, Math.round(jittered)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // Immediate reconnect (watchdog / device wake): a genuine fresh recovery, so
  // reset the backoff first for a fast first attempt. If it fails, onclose
  // falls back to scheduleReconnect with growing delays.
  reconnectNow() {
    if (this.intentionalClose || !this.connectionParams) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  // Device woke / network returned / tab refocused: a still-"OPEN" socket may
  // actually be dead, so probe it; if it is already closed, reconnect now.
  handleNetworkWake() {
    if (this.intentionalClose || !this.connectionParams) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendPing();
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.reconnectNow();
    }
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

  // Crocodile "draw" mode: the performer streams pen-stroke ops live; mirrors
  // the karaoke chunk pipeline above.
  sendDrawingStart(questionId, performanceId) {
    this.send({ type: 'drawing_start', data: { questionId, performanceId } });
  }

  sendDrawingStroke(questionId, performanceId, seq, ops) {
    this.send({ type: 'drawing_stroke', data: { questionId, performanceId, seq, ops } });
  }

  sendDrawingEnd(questionId, performanceId) {
    this.send({ type: 'drawing_end', data: { questionId, performanceId } });
  }

  sendDrawingSync(questionId) {
    this.send({ type: 'drawing_sync', data: { questionId } });
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
    this.reconnectAttempts = 0;
    this.stopHeartbeat();
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
