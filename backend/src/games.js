const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { normalizeQuestion, isHiddenUntilReveal, isMultiBuzz } = require('./questionModel');
const { normalizePlayerColor } = require('./profile');
const { normalizeSpectrumConfig } = require('./spectrum');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const EMPTY_GAME_TTL_MS = 15 * 60 * 1000; // remove a game 15 minutes after the last person left
const SWEEP_INTERVAL_MS = 60 * 1000;

// One running game: lobby metadata + the per-game state that used to be
// global (scores, selections, reveals, times, answers...) + its sockets.
class Game {
  constructor({ id, hostToken, hostName, hostImageUrl, hostColor, password, mode, spectrogramClueMode }) {
    this.id = id;
    this.hostToken = hostToken;
    this.hostName = hostName;
    this.hostImageUrl = hostImageUrl || '';
    this.hostColor = normalizePlayerColor(hostColor);
    this.password = password || null;
    this.mode = mode === 'spectrogram' ? 'spectrogram' : 'quiz';
    this.spectrogramClueMode = spectrogramClueMode === 'verbal' ? 'verbal' : 'text';
    this.status = this.mode === 'spectrogram' ? 'lobby' : 'awaiting_pack'; // awaiting_pack -> lobby -> started
    this.createdAt = Date.now();
    this.emptySince = Date.now(); // nobody is connected right after creation

    this.packName = this.mode === 'spectrogram' ? 'Спектрограма' : null;
    this.packAuthor = null;
    this.packSize = 0;
    this.questionTypes = new Map(); // questionId -> type; the only pack data kept in memory

    this.sockets = new Set();
    this.cacheKey = crypto.randomUUID();
    this.onlineUsers = new Map(); // ws -> user data
    this.persistentUsers = new Map(); // userId -> user data
    this.userScores = new Map();
    this.selectedQuestions = new Set();
    this.revealedQuestions = new Set();
    this.questionTimes = new Map();
    this.questionClicks = new Map();
    this.questionAnswers = new Map();
    this.revealedAnswers = new Set();
    // Kept separate so approximate point circles can be broadcast without
    // leaking exact coordinates through the generic submission channel.
    this.pointAnswers = new Map();
    this.pointHints = new Map();
    this.revealedPointAnswers = new Set();
    this.questionSelectors = new Map();
    this.secretAssignments = new Map();
    // questionId -> { targetUserId, selectorUserId, performance }
    // performance: { id, durationMs, ended, chunks: [{seq, t, b64}] }
    // Chunks are an in-memory backlog so late joiners can catch up:
    // MediaRecorder output is only decodable as a prefix-complete sequence.
    this.karaoke = new Map();
    // questionId -> { targetUserId, selectorUserId, response }
    // Crocodile: one chosen player privately sees the question and submits a
    // text/image/audio response; everyone else then guesses by buzzing.
    this.crocodile = new Map();
    // questionId -> { id, ended, batches: [{seq, ops}] }
    // Crocodile "draw" mode: the assigned performer (kept in `crocodile`)
    // streams pen-stroke ops live. `batches` is an in-memory backlog so late
    // joiners can replay the picture so far. Mirrors the karaoke chunk backlog.
    this.drawing = new Map();
    // Voting: everyone submits an answer (reusing questionAnswers), the host
    // reveals them, then each player casts one final vote for someone else's
    // answer. questionId -> Map(voterId -> targetUserId).
    this.votes = new Map();
    this.revealedVotes = new Set();
    // questionId -> 'open' | 'closed'. Open shows vote targets live to
    // everyone; closed hides them (from everyone, host included) until the
    // host reveals. Indexed from the pack alongside questionTypes.
    this.questionVoteModes = new Map();
    // questionId -> bool. Whether per-player submissions stay masked from
    // other players until the host reveals them. Indexed from the pack
    // alongside questionTypes (pack metadata, not per-round state).
    this.questionHidden = new Map();
    // questionId -> bool. Multi-buzz questions: the host's verdict consumes
    // the player's buzz (cleared server-side) so they may buzz again.
    this.questionMultiBuzz = new Map();
    this.questionImageAspects = new Map();
    this.questionAccuracyPercents = new Map();
    this.questionSpectrumConfigs = new Map();
    // questionId -> [prior question ids in the same theme]. Only questions in
    // ordered themes are indexed: they unlock strictly left to right, so a
    // question is selectable only once all of its predecessors are closed.
    this.questionPredecessors = new Map();
    this.lastGreenFrameUser = null;
    // The question the room is currently on (set on select/reveal, cleared on
    // return-to-game). A (re)connecting client reads it to land on the right
    // screen instead of being stuck on whatever page it had before the drop.
    this.currentQuestionId = null;
    // questionId -> { selectorId, clueGiverId, target, clue, guesses, revealed }
    // Scores remain host-controlled; this state only powers the reveal and
    // client-side score suggestions.
    this.spectrum = new Map();
    // Endless Spectrogram rooms do not use a quiz pack. The active generated
    // spectrum lives here and is replaced only when the host advances.
    this.spectrogramRound = null;
    this.spectrogramRoundNumber = 0;
    this.spectrogramRecentPairIds = [];
  }

  get packPath() {
    return path.join(PACKS_DIR, `${this.id}.json`);
  }

  hostOnline() {
    for (const ws of this.sockets) {
      if (ws.isHost) return true;
    }
    return false;
  }

  // Public lobby/list representation
  toListInfo() {
    return {
      id: this.id,
      mode: this.mode,
      spectrogramClueMode: this.spectrogramClueMode,
      packName: this.packName,
      packAuthor: this.packAuthor,
      packSize: this.packSize,
      hostName: this.hostName,
      hostImageUrl: this.hostImageUrl,
      hostColor: this.hostColor,
      hasPassword: !!this.password,
      status: this.status,
      playerCount: this.persistentUsers.size,
      hostOnline: this.hostOnline(),
      createdAt: this.createdAt
    };
  }

  getQuestionType(questionId) {
    if (this.mode === 'spectrogram' && Number(questionId) === Number(this.spectrogramRound?.question?.id)) {
      return 'spectrum';
    }
    return this.questionTypes.get(questionId) || null;
  }

  isMultiBuzzQuestion(questionId) {
    return this.questionMultiBuzz.get(questionId) === true;
  }

  getSpectrumConfig(questionId) {
    if (this.mode === 'spectrogram' && Number(questionId) === Number(this.spectrogramRound?.question?.id)) {
      return normalizeSpectrumConfig(this.spectrogramRound.question);
    }
    return this.questionSpectrumConfigs.get(questionId) || null;
  }

  // Ordered themes: a question may be selected only once every question to its
  // left in the theme is closed. The host can skip one by closing it from the
  // board (question_toggle), which unlocks the next.
  isQuestionSelectable(questionId) {
    const predecessors = this.questionPredecessors.get(questionId);
    if (!predecessors) return true;
    return predecessors.every((id) => this.selectedQuestions.has(id));
  }

  broadcast(payload) {
    const message = JSON.stringify(payload);
    this.sockets.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  broadcastOnlineUsers() {
    this.broadcast({
      type: 'online_users',
      data: Array.from(this.persistentUsers.values())
    });
  }

  broadcastSelectedQuestions() {
    this.broadcast({
      type: 'selected_questions_update',
      data: Array.from(this.selectedQuestions)
    });
  }

  broadcastGameInfo() {
    this.broadcast({ type: 'game_info', data: this.toListInfo() });
  }

  regenerateCacheKey() {
    this.cacheKey = crypto.randomUUID();
    this.broadcast({
      type: 'cache_key_update',
      data: { cacheKey: this.cacheKey }
    });
    return this.cacheKey;
  }

  resetQuestionState() {
    this.currentQuestionId = null;
    this.selectedQuestions.clear();
    this.revealedQuestions.clear();
    this.questionTimes.clear();
    this.broadcast({ type: 'clear_question_times' });
    this.questionSelectors.clear();
    this.secretAssignments.clear();
    this.karaoke.clear();
    this.crocodile.clear();
    this.drawing.clear();
    this.votes.clear();
    this.revealedVotes.clear();
    this.questionClicks.clear();
    this.questionAnswers.clear();
    this.revealedAnswers.clear();
    this.pointAnswers.clear();
    this.pointHints.clear();
    this.revealedPointAnswers.clear();
    this.spectrum.clear();
    this.broadcastSelectedQuestions();
  }

  // Returning to the board ends any live performance: nobody can listen
  // anymore, so the chunk backlog is just dead weight in memory
  closeKaraokePerformances() {
    for (const entry of this.karaoke.values()) {
      if (entry.performance) {
        entry.performance.ended = true;
        entry.performance.chunks = [];
      }
    }
  }

  // Same idea for live crocodile drawings: once everyone is back on the board
  // the stroke backlog is dead weight.
  closeDrawingPerformances() {
    for (const perf of this.drawing.values()) {
      perf.ended = true;
      perf.batches = [];
    }
  }

  // The single player allowed to stream a live drawing for a question: the
  // crocodile performer, or the cat-in-the-bag (exclusive selection) chosen
  // player. Used to gate the drawing_* messages.
  getDrawingTarget(questionId) {
    const croc = this.crocodile.get(questionId);
    if (croc && croc.targetUserId) return croc.targetUserId;
    const secret = this.secretAssignments.get(questionId);
    return secret ? secret.targetUserId : null;
  }

  getSecretInfo(questionId) {
    return {
      selectorId: this.questionSelectors.get(questionId) || null,
      assignment: this.secretAssignments.get(questionId) || null,
      revealed: this.revealedQuestions.has(questionId)
    };
  }

  getCrocodileInfo(questionId) {
    const entry = this.crocodile.get(questionId);
    return {
      // Before any assignment the question selector is the one allowed to pick
      // the performer (plus the host) — same idea as cat-in-the-bag
      selectorId: (entry && entry.selectorUserId) || this.questionSelectors.get(questionId) || null,
      targetUserId: entry ? entry.targetUserId : null,
      response: entry ? entry.response : null,
      revealed: this.revealedQuestions.has(questionId),
      // Draw mode: tells a (re)joining client there is a live/finished drawing
      // to catch up on via a drawing_sync over the socket.
      drawing: this.drawing.has(questionId)
        ? { id: this.drawing.get(questionId).id, ended: this.drawing.get(questionId).ended }
        : null
    };
  }

  getQuestionTimes(questionId) {
    return this.questionTimes.get(questionId) || new Map();
  }

  getQuestionClicks(questionId) {
    return this.questionClicks.get(questionId) || new Map();
  }

  getNumberAnswersInfo(questionId) {
    return {
      revealed: this.revealedAnswers.has(questionId),
      answers: this.questionAnswers.get(questionId) || new Map()
    };
  }

  getPointAnswersInfo(questionId) {
    return {
      revealed: this.revealedPointAnswers.has(questionId),
      answers: this.pointAnswers.get(questionId) || new Map(),
      hints: this.pointHints.get(questionId) || new Map()
    };
  }

  getQuestionImageAspect(questionId) {
    const aspect = this.questionImageAspects.get(questionId);
    return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  }

  getQuestionAccuracyPercent(questionId) {
    const accuracy = this.questionAccuracyPercents.get(questionId);
    return Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 2;
  }

  getVoteMode(questionId) {
    return this.questionVoteModes.get(questionId) === 'closed' ? 'closed' : 'open';
  }

  // Voting answers are never broadcast unmasked to players (host-only live
  // view); every other submission type follows its indexed hidden flag.
  isAnswerHidden(questionId) {
    if (this.getQuestionType(questionId) === 'voting') return true;
    return this.questionHidden.get(questionId) === true;
  }

  getVotesInfo(questionId) {
    return {
      revealed: this.revealedVotes.has(questionId),
      voteMode: this.getVoteMode(questionId),
      votes: this.votes.get(questionId) || new Map()
    };
  }
}

class GameManager {
  constructor() {
    this.games = new Map();
    fs.mkdirSync(PACKS_DIR, { recursive: true });
    // Packs from a previous run have no matching game anymore - drop them
    for (const file of fs.readdirSync(PACKS_DIR)) {
      try {
        fs.unlinkSync(path.join(PACKS_DIR, file));
      } catch (e) { /* best effort */ }
    }
    this.sweeper = setInterval(() => this.sweepEmptyGames(), SWEEP_INTERVAL_MS);
  }

  createGame({ hostName, hostImageUrl, hostColor, password, mode, spectrogramClueMode }) {
    const game = new Game({
      id: crypto.randomBytes(4).toString('hex'),
      hostToken: crypto.randomUUID(),
      hostName,
      hostImageUrl,
      hostColor,
      password,
      mode,
      spectrogramClueMode,
    });
    this.games.set(game.id, game);
    return game;
  }

  getGame(id) {
    return this.games.get(id);
  }

  // Games visible on the main page (pack uploaded and validated)
  listGames() {
    return Array.from(this.games.values())
      .filter(game => game.status !== 'awaiting_pack')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(game => game.toListInfo());
  }

  deleteGame(id, reason = 'deleted') {
    const game = this.games.get(id);
    if (!game) return false;
    this.games.delete(id);
    game.broadcast({ type: 'game_deleted', data: { gameId: id, reason } });
    game.sockets.forEach(ws => {
      try { ws.close(); } catch (e) { /* already closing */ }
    });
    fs.unlink(game.packPath, () => {});
    console.log(`Game ${id} removed (${reason})`);
    return true;
  }

  sweepEmptyGames() {
    const now = Date.now();
    for (const game of this.games.values()) {
      if (game.sockets.size === 0 && game.emptySince && now - game.emptySince > EMPTY_GAME_TTL_MS) {
        this.deleteGame(game.id, 'inactive');
      }
    }
  }

  // Parse the uploaded pack file once to validate it and build the light
  // question-type index, then let the parsed object be garbage collected -
  // the pack itself lives on disk only.
  indexPackFile(game) {
    const raw = fs.readFileSync(game.packPath, 'utf8');
    const pack = JSON.parse(raw);
    if (!pack || typeof pack !== 'object' || !Array.isArray(pack.rounds)) {
      throw new Error('Pack must be an object with a rounds array');
    }
    const types = new Map();
    const voteModes = new Map();
    const hidden = new Map();
    const multiBuzz = new Map();
    const imageAspects = new Map();
    const accuracyPercents = new Map();
    const spectrumConfigs = new Map();
    const predecessors = new Map();
    for (const round of pack.rounds) {
      for (const theme of round.themes || []) {
        // Ordered theme: questions unlock left to right. Empty placeholders
        // can never be selected, so they don't take part in the chain.
        const priorIds = theme.ordered === true ? [] : null;
        for (const rawQ of theme.questions || []) {
          // Normalize legacy types (secret / text-answer) to base type + options
          const q = normalizeQuestion(rawQ);
          if (q && q.id !== undefined) {
            types.set(q.id, q.type || 'normal');
            if (q.type === 'voting') {
              voteModes.set(q.id, q.vote_mode === 'closed' ? 'closed' : 'open');
            }
            hidden.set(q.id, isHiddenUntilReveal(q));
            if (isMultiBuzz(q)) {
              multiBuzz.set(q.id, true);
            }
            if (q.type === 'point-on-image') {
              const aspect = Number(q.image_aspect_ratio);
              const accuracy = Number(q.accuracy_percent);
              imageAspects.set(q.id, Number.isFinite(aspect) && aspect > 0 ? aspect : 1);
              accuracyPercents.set(q.id, Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 2);
            }
            if (q.type === 'spectrum') {
              spectrumConfigs.set(q.id, normalizeSpectrumConfig(q));
            }
            if (priorIds && q.type !== 'empty') {
              if (priorIds.length > 0) {
                predecessors.set(q.id, [...priorIds]);
              }
              priorIds.push(q.id);
            }
          }
        }
      }
    }
    game.questionTypes = types;
    game.questionVoteModes = voteModes;
    game.questionHidden = hidden;
    game.questionMultiBuzz = multiBuzz;
    game.questionImageAspects = imageAspects;
    game.questionAccuracyPercents = accuracyPercents;
    game.questionSpectrumConfigs = spectrumConfigs;
    game.questionPredecessors = predecessors;
    game.packName = typeof pack.name === 'string' ? pack.name : 'Unnamed pack';
    game.packAuthor = typeof pack.author === 'string' ? pack.author : '';
    try {
      game.packSize = fs.statSync(game.packPath).size;
    } catch (e) {
      game.packSize = 0;
    }
  }
}

module.exports = { GameManager, Game, PACKS_DIR };
