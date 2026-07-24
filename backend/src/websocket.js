const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('./config');
const { isNormalizedPoint, createPointHint } = require('./pointGeometry');
const { normalizePlayerColor } = require('./profile');
const { createSpectrumTarget, wrapSpectrumPosition } = require('./spectrum');
const { startSpectrogramRound } = require('./spectrogram');

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
      if (game.mode === 'spectrogram' && game.spectrogramRound) {
        ws.send(JSON.stringify({ type: 'spectrogram_round', data: game.spectrogramRound }));
        this.sendSpectrumState(game, ws, game.spectrogramRound.question.id);
      }
      // The screen the room is currently on, so a (re)joining client can
      // navigate straight to it (per-question state then rehydrates via REST).
      if (game.currentQuestionId != null) {
        ws.send(JSON.stringify({
          type: 'current_question',
          data: {
            questionId: game.currentQuestionId,
            revealed: game.revealedQuestions.has(game.currentQuestionId)
          }
        }));
      }

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
    if (data.type === 'ping') {
      // Client-side liveness check: answer so the client knows the socket is
      // still alive (a missed pong is how the client detects a half-open drop)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      return;
    }
    if (data.type === 'user_login') {
      const userData = { ...(data.data || {}) };
      const normalizedColor = normalizePlayerColor(userData.color);
      if (normalizedColor) userData.color = normalizedColor;
      else delete userData.color;
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
        if (game.mode === 'spectrogram' && game.persistentUsers.size === 0) return;
        game.status = 'started';
        game.broadcast({ type: 'game_started', data: { gameId: game.id } });
        game.broadcastGameInfo();
        if (game.mode === 'spectrogram') {
          const round = startSpectrogramRound(game);
          if (round) {
            game.broadcast({ type: 'spectrogram_round', data: round });
            this.broadcastSpectrumState(game, round.question.id);
          }
        }
      }
    } else if (data.type === 'spectrogram_sync') {
      if (game.mode !== 'spectrogram' || !game.spectrogramRound) return;
      ws.send(JSON.stringify({ type: 'spectrogram_round', data: game.spectrogramRound }));
      this.sendSpectrumState(game, ws, game.spectrogramRound.question.id);
    } else if (data.type === 'spectrogram_next') {
      if (!ws.isHost || game.mode !== 'spectrogram' || game.status !== 'started') return;
      const active = game.spectrogramRound
        ? game.spectrum.get(game.spectrogramRound.question.id)
        : null;
      // Results should be shown before a round can be replaced.
      if (active && !active.revealed) return;
      const round = startSpectrogramRound(game);
      if (!round) return;
      game.broadcast({ type: 'spectrogram_round', data: round });
      this.broadcastSpectrumState(game, round.question.id);
    } else if (data.type === 'update_host_profile') {
      // Host edits their own nickname/avatar from the profile modal; apply it
      // to the game and rebroadcast so every client updates live.
      if (ws.isHost) {
        const { name, imageUrl, color } = data.data || {};
        if (typeof name === 'string' && name.trim()) {
          game.hostName = name.trim();
        }
        if (typeof imageUrl === 'string') {
          game.hostImageUrl = imageUrl.trim();
        }
        const normalizedColor = normalizePlayerColor(color);
        if (normalizedColor) {
          game.hostColor = normalizedColor;
        }
        game.broadcastGameInfo();
      }
    } else if (data.type === 'question_select') {
      const { questionId, userId } = data.data;
      // Ordered themes unlock strictly left to right; an out-of-order select
      // (stale board, race) is ignored so the room state never skips ahead
      if (!game.isQuestionSelectable(questionId)) return;
      const selectorId = userId || game.lastGreenFrameUser;
      if (selectorId) {
        game.questionSelectors.set(questionId, selectorId);
      }
      game.selectedQuestions.add(questionId);
      game.currentQuestionId = questionId; // the room is now on this question
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
      game.currentQuestionId = data.data.questionId; // reveal may arrive without a prior select
      game.broadcast({ type: 'question_reveal', data: data.data });
    } else if (data.type === 'answer_reveal') {
      game.broadcast({ type: 'answer_reveal', data: data.data });
    } else if (data.type === 'response_reveal') {
      game.broadcast({ type: 'response_reveal', data: data.data });
    } else if (data.type === 'return_to_game') {
      game.currentQuestionId = null; // back on the board
      game.closeKaraokePerformances();
      game.closeDrawingPerformances();
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
      this.clearMultiBuzz(game, data.data.userId);
    } else if (data.type === 'admin_clicked_green_number') {
      game.lastGreenFrameUser = data.data.userId;
      game.broadcast({ type: 'admin_clicked_green_number', data: data.data });
      if (data.data.reason !== 'selection') {
        this.clearMultiBuzz(game, data.data.userId);
      }
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
    } else if (data.type === 'point_answer') {
      const { questionId, point } = data.data || {};
      const sender = game.onlineUsers.get(ws);
      if (game.getQuestionType(questionId) !== 'point-on-image'
        || !sender || !isNormalizedPoint(point)
        || game.revealedPointAnswers.has(questionId)) {
        return;
      }
      if (!game.pointAnswers.has(questionId)) {
        game.pointAnswers.set(questionId, new Map());
        game.pointHints.set(questionId, new Map());
      }
      const answers = game.pointAnswers.get(questionId);
      if (!answers.has(sender.id)) {
        const storedPoint = { x: point.x, y: point.y };
        const hint = createPointHint(
          storedPoint,
          game.getQuestionImageAspect(questionId),
          game.getQuestionAccuracyPercent(questionId)
        );
        answers.set(sender.id, storedPoint);
        game.pointHints.get(questionId).set(sender.id, hint);
        // Only the randomized circle is public until the host reveals answers.
        game.broadcast({
          type: 'point_answer_submitted',
          data: { questionId, userId: sender.id, hint }
        });
      }
    } else if (data.type === 'reveal_point_answers') {
      const { questionId } = data.data || {};
      if (!ws.isHost || game.getQuestionType(questionId) !== 'point-on-image'
        || game.revealedPointAnswers.has(questionId)) {
        return;
      }
      game.revealedPointAnswers.add(questionId);
      game.broadcast({
        type: 'point_answers',
        data: {
          questionId,
          answers: Object.fromEntries(game.pointAnswers.get(questionId) || new Map())
        }
      });
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
          if (qType === 'voting' || qType === 'crocodile') {
            // Voting and crocodile guesses reach the host unmasked (live
            // moderation / scoring) but stay masked for players until reveal.
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
        const guessHistories = game.getQuestionType(questionId) === 'crocodile'
          ? Object.fromEntries(game.getCrocodileGuessesInfo(questionId).guesses)
          : undefined;
        game.broadcast({
          type: 'number_answers',
          data: { questionId, answers: Object.fromEntries(answers), guessHistories }
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
        const samePerformer = existing?.targetUserId === targetUserId;
        if (existing && !samePerformer) {
          game.crocodileGuesses.delete(questionId);
          game.questionAnswers.delete(questionId);
        }
        game.crocodile.set(questionId, {
          targetUserId,
          selectorUserId: selectorUserId || (existing ? existing.selectorUserId : null),
          response: existing ? existing.response : null,
          startedAt: samePerformer ? (existing.startedAt || Date.now()) : Date.now()
        });
        game.broadcast({
          type: 'crocodile_assign',
          data: { questionId, targetUserId, selectorUserId: selectorUserId || null }
        });
      }
    } else if (data.type === 'crocodile_guess') {
      // Text-mode Crocodile is an active guessing game: a player can submit
      // several attempts while the drawing develops. Keep a bounded, timed
      // history and also mirror the latest value into questionAnswers so the
      // existing host scoring/reveal flow remains compatible.
      const { questionId, value } = data.data || {};
      const entry = game.crocodile.get(questionId);
      const sender = game.onlineUsers.get(ws);
      if (!entry || !sender || sender.id === entry.targetUserId
        || game.revealedAnswers.has(questionId) || !this.isValidAnswerValue(value)) {
        return;
      }
      if (!game.crocodileGuesses.has(questionId)) {
        game.crocodileGuesses.set(questionId, new Map());
      }
      const histories = game.crocodileGuesses.get(questionId);
      const history = histories.get(sender.id) || [];
      if (history.length >= 20) return;
      const guess = {
        value,
        time: Number((Math.max(0, Date.now() - (entry.startedAt || Date.now())) / 1000).toFixed(3))
      };
      // Bound the full per-player history as well as each individual answer.
      if (JSON.stringify([...history, guess]).length > 8000000) return;
      history.push(guess);
      histories.set(sender.id, history);
      if (!game.questionAnswers.has(questionId)) {
        game.questionAnswers.set(questionId, new Map());
      }
      game.questionAnswers.get(questionId).set(sender.id, value);

      game.sockets.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        const clientUser = game.onlineUsers.get(client);
        const maySeeGuess = client.isHost || clientUser?.id === sender.id;
        client.send(JSON.stringify({
          type: 'crocodile_guess_submitted',
          data: {
            questionId,
            userId: sender.id,
            count: history.length,
            ...(maySeeGuess ? { guess } : {})
          }
        }));
      });
    } else if (data.type === 'crocodile_response') {
      // The chosen performer normally submits; the host may also finalize the
      // host-side replay when ending a live drawing. First valid response wins.
      const { questionId, value } = data.data;
      const entry = game.crocodile.get(questionId);
      const sender = game.onlineUsers.get(ws);
      const maySubmit = ws.isHost || (sender && sender.id === entry?.targetUserId);
      if (entry && !entry.response && maySubmit && this.isValidAnswerValue(value)) {
        entry.response = value;
        game.broadcast({
          type: 'crocodile_response',
          data: { questionId, userId: entry.targetUserId, value }
        });
      }
    } else if (data.type === 'drawing_start') {
      // The single designated drawer (crocodile performer or cat-in-the-bag
      // chosen player) (re)starts a live drawing. A restart (refresh mid-draw)
      // mints a new performance id and a fresh backlog — watchers reset their
      // canvas when the id changes.
      const { questionId, performanceId } = data.data;
      const target = game.getDrawingTarget(questionId);
      const sender = game.onlineUsers.get(ws);
      if (target && performanceId && sender && sender.id === target) {
        game.drawing.set(questionId, { id: performanceId, ended: false, batches: [] });
        game.broadcast({ type: 'drawing_start', data: { questionId, performanceId } });
      }
    } else if (data.type === 'drawing_stroke') {
      // A batch of pen-stroke ops from the drawer: store for late joiners and
      // relay to everyone else. Ops are tiny normalized JSON; the caps only
      // guard against something pathological.
      const { questionId, performanceId, seq, ops } = data.data;
      const perf = game.drawing.get(questionId);
      const target = game.getDrawingTarget(questionId);
      const sender = game.onlineUsers.get(ws);
      if (perf && perf.id === performanceId && !perf.ended
        && target && sender && sender.id === target
        && Array.isArray(ops) && ops.length > 0 && ops.length <= 2000
        && Number.isFinite(Number(seq))
        && JSON.stringify(ops).length <= 200000) {
        const batch = { seq: Number(seq), ops };
        perf.batches.push(batch);
        // Bound memory: a very long drawing drops its oldest batches (a late
        // joiner then misses the very start, never the recent picture).
        if (perf.batches.length > 6000) perf.batches.shift();
        const message = JSON.stringify({
          type: 'drawing_stroke',
          data: { questionId, performanceId, ...batch }
        });
        game.sockets.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        });
      }
    } else if (data.type === 'drawing_end') {
      // The performer pressed Done, or the host ended the round. Unlike karaoke
      // the backlog is kept: a refresher after the end still replays the
      // finished picture (cleared only on return_to_game).
      const { questionId, performanceId } = data.data;
      const perf = game.drawing.get(questionId);
      const target = game.getDrawingTarget(questionId);
      const sender = game.onlineUsers.get(ws);
      const mayEnd = ws.isHost || (sender && target && sender.id === target);
      if (perf && perf.id === performanceId && !perf.ended && mayEnd) {
        perf.ended = true;
        game.broadcast({ type: 'drawing_end', data: { questionId, performanceId } });
      }
    } else if (data.type === 'drawing_sync') {
      // A (re)joining client catches up: current assignment/performance state,
      // then the full stroke backlog so its canvas rebuilds the picture so far.
      // Replayed even when ended (so a refresher sees the finished drawing).
      const { questionId } = data.data || {};
      const perf = game.drawing.get(questionId);
      ws.send(JSON.stringify({
        type: 'drawing_state',
        data: {
          questionId,
          targetUserId: game.getDrawingTarget(questionId),
          performance: perf ? { id: perf.id, ended: perf.ended } : null
        }
      }));
      if (perf) {
        perf.batches.forEach((batch) => {
          ws.send(JSON.stringify({
            type: 'drawing_stroke',
            data: { questionId, performanceId: perf.id, ...batch }
          }));
        });
      }
    } else if (data.type === 'spectrum_assign') {
      const { questionId, targetUserId } = data.data || {};
      if (game.getQuestionType(questionId) !== 'spectrum' || !targetUserId
        || !game.persistentUsers.has(targetUserId)) {
        return;
      }
      const sender = game.onlineUsers.get(ws);
      const existing = game.spectrum.get(questionId);
      const selectorId = (existing && existing.selectorId)
        || game.questionSelectors.get(questionId)
        || null;
      const mayAssign = ws.isHost || (!!sender && sender.id === selectorId);
      const mayReplace = !existing
        || (ws.isHost && !existing.clue && !existing.guessingEndsAt && !existing.revealed);
      if (!mayAssign || !mayReplace) return;

      const config = game.getSpectrumConfig(questionId);
      if (!config || (!config.allowSelfPick && targetUserId === selectorId)) return;
      const guessingStartedAt = config.clueMode === 'verbal' ? Date.now() : null;
      game.spectrum.set(questionId, {
        selectorId,
        clueGiverId: targetUserId,
        target: createSpectrumTarget(config),
        clueMode: config.clueMode,
        clue: null,
        guesses: new Map(),
        guessTimes: new Map(),
        hostGuess: null,
        hostGuessTime: null,
        revealed: false,
        guessingStartedAt,
        guessingEndsAt: config.clueMode === 'verbal'
          ? guessingStartedAt + config.duration * 1000
          : null,
      });
      this.broadcastSpectrumState(game, questionId);
    } else if (data.type === 'spectrum_clue') {
      const { questionId, clue } = data.data || {};
      const entry = game.spectrum.get(questionId);
      const sender = game.onlineUsers.get(ws);
      const normalizedClue = typeof clue === 'string' ? clue.trim().slice(0, 300) : '';
      const clueMode = entry && (entry.clueMode || game.getSpectrumConfig(questionId)?.clueMode || 'text');
      if (!entry || clueMode === 'verbal' || entry.clue || entry.revealed || !normalizedClue
        || !sender || sender.id !== entry.clueGiverId) {
        return;
      }
      entry.clue = normalizedClue;
      const config = game.getSpectrumConfig(questionId);
      entry.guessingStartedAt = Date.now();
      entry.guessingEndsAt = entry.guessingStartedAt + ((config && config.duration) || 60) * 1000;
      this.broadcastSpectrumState(game, questionId);
    } else if (data.type === 'spectrum_guess') {
      const { questionId, position } = data.data || {};
      const entry = game.spectrum.get(questionId);
      const sender = game.onlineUsers.get(ws);
      const clueMode = entry && (entry.clueMode || game.getSpectrumConfig(questionId)?.clueMode || 'text');
      const guessingStarted = clueMode === 'verbal' || !!entry?.clue;
      if (!entry || !guessingStarted || entry.revealed || !sender
        || sender.id === entry.clueGiverId || !Number.isFinite(Number(position))) {
        return;
      }
      // A marker is editable right up until the host reveals the spectrum.
      entry.guesses.set(sender.id, wrapSpectrumPosition(Number(position)));
      if (!entry.guessTimes) entry.guessTimes = new Map();
      entry.guessTimes.set(sender.id, Math.max(0, Date.now() - (entry.guessingStartedAt || Date.now())));
      this.broadcastSpectrumState(game, questionId);
    } else if (data.type === 'spectrum_host_guess') {
      const { questionId, position } = data.data || {};
      const entry = game.spectrum.get(questionId);
      const clueMode = entry && (entry.clueMode || game.getSpectrumConfig(questionId)?.clueMode || 'text');
      const guessingStarted = clueMode === 'verbal' || !!entry?.clue;
      if (!ws.isHost || !entry || !guessingStarted || entry.revealed
        || !Number.isFinite(Number(position))) {
        return;
      }
      entry.hostGuess = wrapSpectrumPosition(Number(position));
      entry.hostGuessTime = Math.max(0, Date.now() - (entry.guessingStartedAt || Date.now()));
      this.broadcastSpectrumState(game, questionId);
    } else if (data.type === 'spectrum_reveal') {
      const { questionId } = data.data || {};
      const entry = game.spectrum.get(questionId);
      const clueMode = entry && (entry.clueMode || game.getSpectrumConfig(questionId)?.clueMode || 'text');
      const guessingStarted = clueMode === 'verbal' || !!entry?.clue;
      if (!ws.isHost || !entry || !guessingStarted || entry.revealed) return;
      entry.revealed = true;
      this.broadcastSpectrumState(game, questionId);
    } else if (data.type === 'spectrum_sync') {
      const { questionId } = data.data || {};
      if (game.getQuestionType(questionId) !== 'spectrum') return;
      this.sendSpectrumState(game, ws, questionId);
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

  spectrumStateFor(game, ws, questionId) {
    const entry = game.spectrum.get(questionId);
    const sender = game.onlineUsers.get(ws);
    const requesterId = sender ? sender.id : null;
    if (!entry) {
      return {
        questionId,
        phase: 'assigning',
        selectorId: game.questionSelectors.get(questionId) || null,
        clueGiverId: null,
        clueMode: null,
        clue: null,
        submittedUserIds: [],
        revealed: false,
        target: null,
        guesses: {},
        guessTimes: {},
        ownGuess: null,
        hostSubmitted: false,
        hostGuess: null,
        hostGuessTime: null,
        guessingEndsAt: null,
      };
    }
    const clueMode = entry.clueMode || game.getSpectrumConfig(questionId)?.clueMode || 'text';
    const maySeeTarget = entry.revealed || requesterId === entry.clueGiverId;
    const hasHostGuess = entry.hostGuess !== null && entry.hostGuess !== undefined
      && Number.isFinite(Number(entry.hostGuess));
    return {
      questionId,
      phase: entry.revealed ? 'revealed' : (clueMode === 'verbal' || entry.clue) ? 'guessing' : 'clue',
      selectorId: entry.selectorId,
      clueGiverId: entry.clueGiverId,
      clueMode,
      clue: entry.clue,
      submittedUserIds: Array.from(entry.guesses.keys()),
      revealed: entry.revealed,
      target: maySeeTarget ? entry.target : null,
      guesses: entry.revealed ? Object.fromEntries(entry.guesses) : {},
      guessTimes: entry.revealed ? Object.fromEntries(entry.guessTimes || new Map()) : {},
      ownGuess: requesterId && entry.guesses.has(requesterId)
        ? entry.guesses.get(requesterId)
        : null,
      hostSubmitted: hasHostGuess,
      hostGuess: (entry.revealed || ws.isHost) && hasHostGuess
        ? entry.hostGuess
        : null,
      hostGuessTime: (entry.revealed || ws.isHost) && hasHostGuess
        && Number.isFinite(Number(entry.hostGuessTime))
        ? entry.hostGuessTime
        : null,
      guessingEndsAt: entry.guessingEndsAt || null,
    };
  }

  sendSpectrumState(game, ws, questionId) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'spectrum_state',
      data: this.spectrumStateFor(game, ws, questionId),
    }));
  }

  broadcastSpectrumState(game, questionId) {
    game.sockets.forEach(client => this.sendSpectrumState(game, client, questionId));
  }

  // Multi-buzz: the host's verdict (green or red) consumes the player's buzz.
  // Dropping the recorded time re-opens the race for that player — the
  // elapsed_time handler accepts a new buzz once the old one is gone — and
  // buzz_cleared tells clients to reset their local buzz state too.
  clearMultiBuzz(game, userId) {
    const questionId = game.currentQuestionId;
    if (questionId == null || !userId || !game.isMultiBuzzQuestion(questionId)) {
      return;
    }
    const times = game.questionTimes.get(questionId);
    if (times && times.delete(userId)) {
      game.broadcast({ type: 'buzz_cleared', data: { questionId, userId } });
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
