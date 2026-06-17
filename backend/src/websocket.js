const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('./config');

// Routes every WebSocket connection into its game room (?gameId=...) and
// scopes all message handling and broadcasts to that room.
// Protocol-level ping interval. Keeps connections busy so proxies
// (e.g. Cloudflare) don't drop them as idle, and detects dead sockets:
// a client that misses a whole interval without ponging is terminated.
const HEARTBEAT_INTERVAL_MS = 30000;

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.gameManager = null;
    this.heartbeatTimer = null;
  }

  initialize(server, gameManager) {
    this.gameManager = gameManager;
    this.wss = new WebSocket.Server({ server, path: config.wsPath });

    this.heartbeatTimer = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          ws.terminate(); // close handler runs and cleans up the room
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.wss.on('close', () => {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    });

    this.wss.on('connection', (ws, req) => {
      // The base is a throwaway placeholder needed only so URL() can parse
      // the query string of the relative req.url - it is never requested.
      const url = new URL(req.url, 'http://placeholder.invalid');
      const gameId = url.searchParams.get('gameId');
      const hostToken = url.searchParams.get('hostToken');
      const password = url.searchParams.get('password');

      const game = gameId ? this.gameManager.getGame(gameId) : null;
      if (!game) {
        ws.send(JSON.stringify({ type: 'game_not_found', data: { gameId } }));
        ws.close();
        return;
      }

      const isHost = !!hostToken && hostToken === game.hostToken;
      if (!isHost && game.password && password !== game.password) {
        ws.send(JSON.stringify({ type: 'join_rejected', data: { reason: 'wrong_password' } }));
        ws.close();
        return;
      }

      ws.isHost = isHost;
      ws.gameId = game.id;
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      game.sockets.add(ws);
      game.emptySince = null;
      console.log(`Client connected to game ${game.id}${isHost ? ' (host)' : ''}`);

      // Current room state so a (re)joining client can catch up immediately
      ws.send(JSON.stringify({ type: 'game_info', data: game.toListInfo() }));
      ws.send(JSON.stringify({
        type: 'selected_questions_update',
        data: Array.from(game.selectedQuestions)
      }));
      ws.send(JSON.stringify({
        type: 'cache_key_update',
        data: { cacheKey: game.cacheKey }
      }));
      ws.send(JSON.stringify({
        type: 'online_users',
        data: Array.from(game.persistentUsers.values())
      }));

      ws.on('message', (message) => {
        try {
          // The game may have been deleted while this socket was open
          if (!this.gameManager.getGame(ws.gameId)) return;
          this.handleMessage(game, ws, JSON.parse(message));
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      ws.on('close', () => {
        game.sockets.delete(ws);
        const userData = game.onlineUsers.get(ws);
        if (userData) {
          game.onlineUsers.delete(ws);
          game.persistentUsers.delete(userData.id);
          game.broadcastOnlineUsers();
        }
        if (ws.isHost) {
          game.broadcastGameInfo(); // host went offline
        }
        if (game.sockets.size === 0) {
          game.emptySince = Date.now();
        }
      });
    });
  }

  handleMessage(game, ws, data) {
    if (data.type === 'user_login') {
      const userData = data.data;
      if (!userData.id) {
        userData.id = `${userData.name}-${Date.now()}`;
      }
      if (game.userScores.has(userData.id)) {
        // Reconnecting to a game we're already in: restore the score the
        // server has been tracking for us in THIS game.
        userData.score = game.userScores.get(userData.id);
      } else {
        // First time in THIS game: always start at 0. The score the client
        // sends is never trusted - it may be a stale value left in the
        // browser from a previous game. Scores belong to the game, not the
        // user, so they never carry across games.
        userData.score = 0;
        game.userScores.set(userData.id, userData.score);
      }
      game.onlineUsers.set(ws, userData);
      game.persistentUsers.set(userData.id, userData);
      game.broadcastOnlineUsers();
      game.broadcastGameInfo(); // player count changed
    } else if (data.type === 'user_logout') {
      const userData = data.data;
      game.onlineUsers.delete(ws);
      game.persistentUsers.delete(userData.id);
      game.broadcastOnlineUsers();
      game.broadcastGameInfo();
    } else if (data.type === 'start_game') {
      // Only the host can move the lobby into a running game
      if (ws.isHost && game.status === 'lobby') {
        game.status = 'started';
        game.broadcast({ type: 'game_started', data: { gameId: game.id } });
        game.broadcastGameInfo();
      }
    } else if (data.type === 'update_host_profile') {
      // Host edits their own nickname/avatar from the profile modal; apply it
      // to the game and rebroadcast so every client updates live.
      if (ws.isHost) {
        const { name, imageUrl } = data.data || {};
        if (typeof name === 'string' && name.trim()) {
          game.hostName = name.trim();
        }
        if (typeof imageUrl === 'string') {
          game.hostImageUrl = imageUrl.trim();
        }
        game.broadcastGameInfo();
      }
    } else if (data.type === 'question_select') {
      const { questionId, userId } = data.data;
      const selectorId = userId || game.lastGreenFrameUser;
      if (selectorId) {
        game.questionSelectors.set(questionId, selectorId);
      }
      game.selectedQuestions.add(questionId);
      game.broadcast({ type: 'question_select', data: data.data });
      game.broadcastSelectedQuestions();
    } else if (data.type === 'question_toggle') {
      // Host right-clicks a board tile to close it (mark as used) or reopen
      // it, without actually playing the question
      if (!ws.isHost) return;
      const { questionId } = data.data;
      if (game.selectedQuestions.has(questionId)) {
        game.selectedQuestions.delete(questionId);
      } else {
        game.selectedQuestions.add(questionId);
      }
      game.broadcastSelectedQuestions();
    } else if (data.type === 'question_reveal') {
      game.revealedQuestions.add(data.data.questionId);
      game.broadcast({ type: 'question_reveal', data: data.data });
    } else if (data.type === 'answer_reveal') {
      game.broadcast({ type: 'answer_reveal', data: data.data });
    } else if (data.type === 'response_reveal') {
      game.broadcast({ type: 'response_reveal', data: data.data });
    } else if (data.type === 'return_to_game') {
      game.closeKaraokePerformances();
      game.broadcast({ type: 'return_to_game' });
    } else if (data.type === 'elapsed_time') {
      const { questionId, userId } = data.data;
      if (!game.questionTimes.has(questionId)) {
        game.questionTimes.set(questionId, new Map());
      }
      const questionTimes = game.questionTimes.get(questionId);
      if (!questionTimes.has(userId)) {
        questionTimes.set(userId, data.data.elapsedTime);
        game.broadcast({ type: 'elapsed_time', data: data.data });
      }
    } else if (data.type === 'clear_selected_questions') {
      game.selectedQuestions.clear();
      game.broadcastSelectedQuestions();
    } else if (data.type === 'admin_clicked_red_number') {
      game.broadcast({ type: 'admin_clicked_red_number', data: data.data });
    } else if (data.type === 'admin_clicked_green_number') {
      game.lastGreenFrameUser = data.data.userId;
      game.broadcast({ type: 'admin_clicked_green_number', data: data.data });
    } else if (data.type === 'cat_clicks') {
      const { questionId, userId, clicksLeft } = data.data;
      if (userId && Number.isFinite(Number(clicksLeft))) {
        if (!game.questionClicks.has(questionId)) {
          game.questionClicks.set(questionId, new Map());
        }
        game.questionClicks.get(questionId).set(userId, Number(clicksLeft));
        game.broadcast({ type: 'cat_clicks', data: { questionId, userId, clicksLeft: Number(clicksLeft) } });
      }
    } else if (data.type === 'cat_clicks_grant') {
      // Admin grants extra clicks to a player. Each grant carries a unique
      // id so clients can never apply the same grant twice.
      const { questionId, userId, amount } = data.data;
      const numericAmount = Number(amount);
      if (userId && Number.isFinite(numericAmount) && numericAmount > 0) {
        const clicks = game.questionClicks.get(questionId);
        if (clicks && clicks.has(userId)) {
          clicks.set(userId, clicks.get(userId) + numericAmount);
        }
        game.broadcast({
          type: 'cat_clicks_grant',
          data: { questionId, userId, amount: numericAmount, grantId: crypto.randomUUID() }
        });
      }
    } else if (data.type === 'number_answer') {
      // Player submits an answer: a number (close-enough), an array of
      // option indices (choice) or a text/pasted-image string (text-answer).
      // One submission per user; nothing accepted after the reveal.
      const { questionId, userId, value } = data.data;
      if (userId && this.isValidAnswerValue(value) && !game.revealedAnswers.has(questionId)) {
        if (!game.questionAnswers.has(questionId)) {
          game.questionAnswers.set(questionId, new Map());
        }
        const answers = game.questionAnswers.get(questionId);
        if (!answers.has(userId)) {
          answers.set(userId, value);
          const qType = game.getQuestionType(questionId);
          if (qType === 'voting') {
            // Voting answers reach the host unmasked (live moderation) but stay
            // masked for players until the host reveals them
            game.sockets.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: 'number_answer_submitted',
                  data: client.isHost ? { questionId, userId, value } : { questionId, userId }
                }));
              }
            });
          } else if (!game.isAnswerHidden(questionId)) {
            // Live answers (e.g. choice) go out unmasked so the admin — and,
            // for non-hidden questions, everyone — sees results in real time
            game.broadcast({ type: 'number_answer_submitted', data: { questionId, userId, value } });
          } else {
            // Hidden answers: clients only learn that the player answered
            game.broadcast({ type: 'number_answer_submitted', data: { questionId, userId } });
          }
        }
      }
    } else if (data.type === 'reveal_number_answers') {
      const { questionId } = data.data;
      if (!game.revealedAnswers.has(questionId)) {
        game.revealedAnswers.add(questionId);
        const answers = game.questionAnswers.get(questionId) || new Map();
        game.broadcast({
          type: 'number_answers',
          data: { questionId, answers: Object.fromEntries(answers) }
        });
      }
    } else if (data.type === 'secret_assign') {
      const { questionId, targetUserId, selectorUserId } = data.data;
      // First assignment wins; ignore duplicates/races
      if (!game.secretAssignments.has(questionId) && targetUserId) {
        game.secretAssignments.set(questionId, { targetUserId, selectorUserId: selectorUserId || null });
        game.broadcast({
          type: 'secret_assign',
          data: { questionId, targetUserId, selectorUserId: selectorUserId || null }
        });
      }
    } else if (data.type === 'karaoke_assign') {
      const { questionId, targetUserId, selectorUserId } = data.data;
      const existing = game.karaoke.get(questionId);
      // First assignment wins, but the host may re-assign as long as the
      // performance hasn't started (e.g. the chosen player went offline)
      const canAssign = !existing || (ws.isHost && !existing.performance);
      if (targetUserId && canAssign) {
        game.karaoke.set(questionId, {
          targetUserId,
          selectorUserId: selectorUserId || (existing ? existing.selectorUserId : null),
          performance: existing ? existing.performance : null
        });
        game.broadcast({
          type: 'karaoke_assign',
          data: { questionId, targetUserId, selectorUserId: selectorUserId || null }
        });
      }
    } else if (data.type === 'karaoke_start') {
      // The assigned singer (re)starts streaming. A restart (page refresh
      // mid-song) replaces the performance: new id, fresh chunk backlog —
      // listeners reset their decoders when the performance id changes.
      const { questionId, performanceId, durationMs } = data.data;
      const entry = game.karaoke.get(questionId);
      const sender = game.onlineUsers.get(ws);
      if (entry && performanceId && sender && sender.id === entry.targetUserId) {
        const numericDuration = Number(durationMs);
        entry.performance = {
          id: performanceId,
          // Number(null) is 0 - only a real positive length counts
          durationMs: Number.isFinite(numericDuration) && numericDuration > 0 ? numericDuration : null,
          ended: false,
          chunks: []
        };
        game.broadcast({
          type: 'karaoke_start',
          data: { questionId, performanceId, durationMs: entry.performance.durationMs }
        });
      }
    } else if (data.type === 'karaoke_chunk') {
      // Mixed track+voice audio from the singer: store for late joiners and
      // relay to everyone else. ~4KB per 250ms chunk; the size cap only
      // guards against something pathological.
      const { questionId, performanceId, seq, t, b64 } = data.data;
      const entry = game.karaoke.get(questionId);
      const perf = entry && entry.performance;
      const sender = game.onlineUsers.get(ws);
      if (perf && perf.id === performanceId && !perf.ended
        && sender && sender.id === entry.targetUserId
        && typeof b64 === 'string' && b64.length > 0 && b64.length <= 400000
        && Number.isFinite(Number(seq))) {
        const chunk = { seq: Number(seq), t: Number(t) || 0, b64 };
        perf.chunks.push(chunk);
        const message = JSON.stringify({
          type: 'karaoke_chunk',
          data: { questionId, performanceId, ...chunk }
        });
        game.sockets.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        });
      }
    } else if (data.type === 'karaoke_end') {
      // Singer's media ended (or the host cut the performance short)
      const { questionId, performanceId } = data.data;
      const entry = game.karaoke.get(questionId);
      const perf = entry && entry.performance;
      const sender = game.onlineUsers.get(ws);
      const mayEnd = ws.isHost || (sender && entry && sender.id === entry.targetUserId);
      if (perf && perf.id === performanceId && !perf.ended && mayEnd) {
        perf.ended = true;
        perf.chunks = []; // nobody needs the backlog after the performance
        game.broadcast({ type: 'karaoke_end', data: { questionId, performanceId } });
      }
    } else if (data.type === 'karaoke_sync') {
      // A (re)joining client catches up: current assignment/performance state,
      // then the full chunk backlog so its decoder gets a valid stream prefix
      const { questionId } = data.data || {};
      const entry = game.karaoke.get(questionId);
      const perf = entry ? entry.performance : null;
      ws.send(JSON.stringify({
        type: 'karaoke_state',
        data: {
          questionId,
          targetUserId: entry ? entry.targetUserId : null,
          // Before any assignment the question selector is the one allowed
          // to pick the singer (plus the host) - same idea as cat-in-the-bag
          selectorUserId: (entry && entry.selectorUserId)
            || game.questionSelectors.get(questionId)
            || null,
          performance: perf
            ? { id: perf.id, durationMs: perf.durationMs, ended: perf.ended }
            : null
        }
      }));
      if (perf && !perf.ended) {
        perf.chunks.forEach((chunk) => {
          ws.send(JSON.stringify({
            type: 'karaoke_chunk',
            data: { questionId, performanceId: perf.id, ...chunk }
          }));
        });
      }
    } else if (data.type === 'crocodile_assign') {
      const { questionId, targetUserId, selectorUserId } = data.data;
      const existing = game.crocodile.get(questionId);
      // First assignment wins, but the host may re-assign as long as the chosen
      // player hasn't submitted a response yet (e.g. they went offline). Unlike
      // cat-in-the-bag, the selector may pick themselves.
      const canAssign = !existing || (ws.isHost && !existing.response);
      if (targetUserId && canAssign) {
        game.crocodile.set(questionId, {
          targetUserId,
          selectorUserId: selectorUserId || (existing ? existing.selectorUserId : null),
          response: existing ? existing.response : null
        });
        game.broadcast({
          type: 'crocodile_assign',
          data: { questionId, targetUserId, selectorUserId: selectorUserId || null }
        });
      }
    } else if (data.type === 'crocodile_response') {
      // Only the chosen performer may submit, exactly once. The response is a
      // text/image/audio string and is broadcast unmasked so everyone else can
      // start guessing.
      const { questionId, value } = data.data;
      const entry = game.crocodile.get(questionId);
      const sender = game.onlineUsers.get(ws);
      if (entry && !entry.response && sender && sender.id === entry.targetUserId
        && this.isValidAnswerValue(value)) {
        entry.response = value;
        game.broadcast({
          type: 'crocodile_response',
          data: { questionId, userId: sender.id, value }
        });
      }
    } else if (data.type === 'cast_vote') {
      // Voting: each player casts one final vote for another player's answer.
      // Only after the answers have been revealed, never for your own answer,
      // and never twice. In open mode the target goes out unmasked so everyone
      // tallies live; in closed mode only the fact that a vote was cast is
      // broadcast, so nobody (host included) sees targets until the reveal.
      const { questionId, voterId, targetUserId } = data.data;
      if (game.getQuestionType(questionId) === 'voting'
        && voterId && targetUserId && voterId !== targetUserId
        && game.revealedAnswers.has(questionId)
        && !game.revealedVotes.has(questionId)) {
        if (!game.votes.has(questionId)) {
          game.votes.set(questionId, new Map());
        }
        const questionVotes = game.votes.get(questionId);
        if (!questionVotes.has(voterId)) {
          questionVotes.set(voterId, targetUserId);
          const open = game.getVoteMode(questionId) === 'open';
          game.broadcast({
            type: 'vote_cast',
            data: open ? { questionId, voterId, targetUserId } : { questionId, voterId }
          });
        }
      }
    } else if (data.type === 'reveal_votes') {
      // Host ends voting and publishes every target. In open mode counts were
      // already visible, so this just locks further votes; in closed mode it
      // uncovers who voted for whom.
      const { questionId } = data.data;
      if (!game.revealedVotes.has(questionId)) {
        game.revealedVotes.add(questionId);
        const questionVotes = game.votes.get(questionId) || new Map();
        game.broadcast({
          type: 'votes_revealed',
          data: { questionId, votes: Object.fromEntries(questionVotes) }
        });
      }
    } else if (data.type === 'request_selected_questions') {
      ws.send(JSON.stringify({
        type: 'selected_questions_update',
        data: Array.from(game.selectedQuestions)
      }));
    } else if (data.type === 'clear_cache') {
      if (!ws.isHost) return;
      game.resetQuestionState();
      game.persistentUsers.forEach(userData => {
        userData.score = 0;
      });
      game.userScores.clear();
      game.broadcastOnlineUsers();
    } else if (data.type === 'update_score') {
      const { userId, score } = data.data;
      const userData = game.persistentUsers.get(userId);
      if (userData) {
        const numericScore = Number(score);
        if (!Number.isFinite(numericScore)) {
          console.warn(`Ignored invalid score value for user ${userId}:`, score);
          return;
        }
        userData.score = numericScore;
        game.userScores.set(userId, numericScore);
        game.broadcastOnlineUsers();
      }
    } else if (data.type === 'round_change') {
      game.broadcast({ type: 'round_change', data: data.data });
    } else if (data.type === 'media_control') {
      // Admin drives question audio/video for everyone: relay play/pause/seek
      const { questionId, action, time, mediaIndex, src } = data.data || {};
      if (questionId !== undefined && ['play', 'pause', 'seek'].includes(action)) {
        game.broadcast({
          type: 'media_control',
          data: { questionId, action, time, mediaIndex, src }
        });
      }
    }
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
}

const wsManager = new WebSocketManager();
module.exports = wsManager;
