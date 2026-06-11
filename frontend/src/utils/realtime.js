import config from '../config';

// Realtime transport manager. Server -> client is one SSE stream per tab
// (EventSource on /api/games/:gameId/events); client -> server are plain
// POSTs to /api/games/:gameId/actions. The public surface (connect,
// subscribe, sendX, disconnect) is the same as the old WebSocket manager,
// including the 'ws_open' event name consumers resync on.
//
// Liveness: the server emits an application-level `ping` event every 15s on
// the stream (named event - it does not fire onmessage). A watchdog treats a
// stream that stayed silent past STALE_MS while the page is visible as dead:
// mobile browsers and proxies kill connections without firing any event, so
// readyState may claim OPEN forever. The watchdog (and the offline /
// visibility fast paths) emit a synthetic 'connection_lost' for the UI, close
// the stream and reopen it; every successful (re)open emits 'ws_open', which
// drives the same login + REST resync path everywhere.

const PING_INTERVAL_MS = 15000;
// Deliberately generous (~4 missed pings = ~70s of true silence): the server
// pings every 15s, but keeping the watchdog loose stops Cloudflare ping
// jitter/buffering from tripping false reconnects mid-turn.
const STALE_MS = PING_INTERVAL_MS * 4 + 10000;
const WATCHDOG_INTERVAL_MS = 10000;
// Coming back to a visible tab: anything older than this means the nap
// likely killed the stream - reconnect now instead of waiting for the watchdog
const WAKE_STALE_MS = 45000;
// Manual retry delay when the browser gave up reconnecting on its own
const RETRY_DELAY_MS = 5000;
// A successful action POST proves the network path works, so missing pings
// can't be a network blip: if the stream has been silent this long the moment
// a POST succeeds, it is dead - reconnect now instead of waiting out STALE_MS.
// One ping interval + slack keeps tunnel jitter from tripping it.
const POST_STALE_MS = PING_INTERVAL_MS + 10000;

const TERMINAL_EVENTS = ['game_deleted', 'game_not_found', 'join_rejected'];

class RealtimeManager {
  constructor() {
    this.es = null;
    this.subscribers = new Set();
    // Latest server selection set, so a (re)mounting board can re-read it
    // without a round-trip (refreshed by every connect snapshot + broadcast)
    this.selectedQuestions = new Set();
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.intentionalClose = false;
    this.connectionParams = null; // { gameId, hostToken, password } of the active game
    this.lastMessageAt = 0;
    this.connectionDown = false;
    // Per-tab identity: ties this tab's stream to its action POSTs so the
    // server can key presence (user_login) to the stream connection
    this.clientId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => this.handleOffline());
      window.addEventListener('online', () => this.handleOnline());
      document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    }
  }

  // Connect to a specific game room. Reconnects (manual or automatic) reuse
  // the stored params; connecting to a different game replaces the stream.
  connect(params) {
    if (params) {
      const sameGame = this.connectionParams && this.connectionParams.gameId === params.gameId;
      this.connectionParams = params;
      if (!sameGame && this.es) {
        // Switching rooms: drop the old stream first
        this.es.close();
        this.es = null;
        this.selectedQuestions = new Set();
      }
    }
    if (!this.connectionParams) {
      console.error('Realtime connect called without game params');
      return;
    }
    // Never hold two streams: a duplicate means every broadcast is
    // delivered (and applied) twice
    if (this.es && this.es.readyState !== EventSource.CLOSED) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.intentionalClose = false;

    const { gameId, hostToken, password } = this.connectionParams;
    const query = new URLSearchParams({ clientId: this.clientId });
    if (hostToken) query.set('hostToken', hostToken);
    if (password) query.set('password', password);
    const source = new EventSource(`${config.apiUrl}/api/games/${gameId}/events?${query.toString()}`);
    this.es = source;
    this.lastMessageAt = Date.now();

    source.onopen = () => {
      if (this.es !== source) return; // stale stream that was replaced
      console.log('Realtime stream connected');
      this.lastMessageAt = Date.now();
      this.connectionDown = false;
      // Let subscribers (re)introduce themselves and resync, e.g. re-send
      // user_login and refetch per-question state
      this.notifySubscribers({ type: 'ws_open' });
    };

    source.onmessage = (event) => {
      if (this.es !== source) return;
      this.lastMessageAt = Date.now();
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        return; // WS-era keepalive shape; only feeds the watchdog
      }
      if (data.type === 'selected_questions_update') {
        this.selectedQuestions = new Set(data.data);
      }
      if (TERMINAL_EVENTS.includes(data.type)) {
        // Close before notifying: subscribers navigate away on these, and an
        // open EventSource would auto-reconnect and replay the rejection
        this.intentionalClose = true;
        source.close();
      }
      this.notifySubscribers(data);
    };

    // The keepalive is a named event - it never fires onmessage
    source.addEventListener('ping', () => {
      if (this.es !== source) return;
      this.lastMessageAt = Date.now();
    });

    source.onerror = () => {
      if (this.es !== source || this.intentionalClose) return;
      this.emitConnectionLost();
      if (source.readyState === EventSource.CLOSED) {
        // The browser only auto-retries while CONNECTING; a CLOSED source
        // is final, so schedule the retry ourselves
        this.scheduleReconnect();
      }
    };

    this.startWatchdog();
  }

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.checkStale(), WATCHDOG_INTERVAL_MS);
  }

  checkStale() {
    if (!this.es || this.intentionalClose) return;
    // Hidden tabs throttle timers and lose connections by design; judge
    // staleness on the visibilitychange-to-visible path instead, otherwise
    // a woken tab can double-fire reconnects
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this.es.readyState === EventSource.OPEN && Date.now() - this.lastMessageAt > STALE_MS) {
      // Silent death: the socket claims OPEN but nothing (not even pings)
      // has arrived for two intervals
      console.warn('Realtime stream silent for too long, reconnecting');
      this.forceReconnect();
    } else if (this.es.readyState === EventSource.CLOSED && !this.reconnectTimer) {
      // Safety net: a closed stream with no retry pending never recovers
      this.emitConnectionLost();
      this.connect();
    }
  }

  // Close a stream we believe is dead and open a fresh one right away.
  // A closed EventSource never auto-reconnects, so this is manual.
  forceReconnect() {
    if (!this.connectionParams || this.intentionalClose) return;
    this.emitConnectionLost();
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.connect();
  }

  handleOffline() {
    if (!this.connectionParams || this.intentionalClose || !this.es) return;
    // The OS just told us - no need to wait for the watchdog timeout
    this.emitConnectionLost();
    this.es.close();
  }

  handleOnline() {
    if (!this.connectionParams || this.intentionalClose) return;
    // Reconnect now, skipping any pending retry delay
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  handleVisibilityChange() {
    if (typeof document === 'undefined' || document.hidden) return;
    if (!this.connectionParams || this.intentionalClose) return;
    // Phone-wake path: mobile browsers kill background connections without
    // any event; if nothing arrived since before the nap, assume the stream
    // is dead and replace it immediately
    if (Date.now() - this.lastMessageAt > WAKE_STALE_MS) {
      this.forceReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.intentionalClose) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RETRY_DELAY_MS);
  }

  emitConnectionLost() {
    if (this.connectionDown) return;
    this.connectionDown = true;
    this.notifySubscribers({ type: 'connection_lost' });
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notifySubscribers(data) {
    this.subscribers.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        // One broken subscriber must not starve the rest (children subscribe
        // before GameContext, which carries scores and presence)
        console.error('Realtime subscriber error:', error);
      }
    });
  }

  // Called after every successful action POST: the round-trip just proved the
  // server is reachable, so a stream that still missed its pings is dead even
  // though readyState claims OPEN. Reconnecting here turns "admin pressed a
  // button and nothing happened" into an immediate resync.
  assertStreamFresh() {
    if (!this.es || this.intentionalClose) return;
    if (this.es.readyState === EventSource.OPEN && Date.now() - this.lastMessageAt > POST_STALE_MS) {
      console.warn('Action POST succeeded but the stream is silent, reconnecting');
      this.forceReconnect();
    }
  }

  // Deliver an action to the server. Unlike the old WebSocket send(), which
  // silently dropped messages while the socket was down, failures here are
  // at least visible in the console (the UI shows the reconnect banner).
  send(payload) {
    if (!this.connectionParams) {
      console.error('Realtime send called without game params');
      return Promise.resolve(false);
    }
    const { gameId, hostToken } = this.connectionParams;
    const headers = { 'Content-Type': 'application/json' };
    if (hostToken) headers['X-Host-Token'] = hostToken;
    return fetch(`${config.apiUrl}/api/games/${gameId}/actions?clientId=${encodeURIComponent(this.clientId)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    }).then((response) => {
      if (!response.ok) {
        console.error(`Action ${payload.type} rejected with status ${response.status}`);
        return false;
      }
      this.assertStreamFresh();
      return true;
    }).catch((error) => {
      console.error(`Action ${payload.type} failed:`, error);
      return false;
    });
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

  // The server includes the selection set in the connect snapshot, so this
  // no longer asks it anything: it replays the manager's cached copy to
  // subscribers, covering boards that (re)mount between broadcasts.
  // Deferred by a microtask: the board calls this from a mount effect that
  // runs BEFORE its subscribe effect, so a synchronous replay would fire
  // into a not-yet-registered listener and be lost (the old WS round-trip
  // hid this ordering by being async).
  sendRequestSelectedQuestions() {
    queueMicrotask(() => {
      this.notifySubscribers({
        type: 'selected_questions_update',
        data: Array.from(this.selectedQuestions)
      });
    });
  }

  disconnect() {
    this.intentionalClose = true;
    this.connectionParams = null;
    this.connectionDown = false;
    this.selectedQuestions = new Set();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }
}

// Create a singleton instance
const realtimeManager = new RealtimeManager();
export default realtimeManager;
