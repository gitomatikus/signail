const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const EMPTY_GAME_TTL_MS = 15 * 60 * 1000; // remove a game 15 minutes after the last person left
const SWEEP_INTERVAL_MS = 60 * 1000;

// One running game: lobby metadata + the per-game state that used to be
// global (scores, selections, reveals, times, answers...) + its sockets.
class Game {
  constructor({ id, hostToken, hostName, hostImageUrl, password }) {
    this.id = id;
    this.hostToken = hostToken;
    this.hostName = hostName;
    this.hostImageUrl = hostImageUrl || '';
    this.password = password || null;
    this.status = 'awaiting_pack'; // awaiting_pack -> lobby -> started
    this.createdAt = Date.now();
    this.emptySince = Date.now(); // nobody is connected right after creation

    this.packName = null;
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
    // Voting: everyone submits an answer (reusing questionAnswers), the host
    // reveals them, then each player casts one final vote for someone else's
    // answer. questionId -> Map(voterId -> targetUserId).
    this.votes = new Map();
    this.revealedVotes = new Set();
    // questionId -> 'open' | 'closed'. Open shows vote targets live to
    // everyone; closed hides them (from everyone, host included) until the
    // host reveals. Indexed from the pack alongside questionTypes.
    this.questionVoteModes = new Map();
    this.lastGreenFrameUser = null;
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
      packName: this.packName,
      packAuthor: this.packAuthor,
      packSize: this.packSize,
      hostName: this.hostName,
      hostImageUrl: this.hostImageUrl,
      hasPassword: !!this.password,
      status: this.status,
      playerCount: this.persistentUsers.size,
      hostOnline: this.hostOnline(),
      createdAt: this.createdAt
    };
  }

  getQuestionType(questionId) {
    return this.questionTypes.get(questionId) || null;
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
    this.selectedQuestions.clear();
    this.revealedQuestions.clear();
    this.questionTimes.clear();
    this.broadcast({ type: 'clear_question_times' });
    this.questionSelectors.clear();
    this.secretAssignments.clear();
    this.karaoke.clear();
    this.crocodile.clear();
    this.votes.clear();
    this.revealedVotes.clear();
    this.questionClicks.clear();
    this.questionAnswers.clear();
    this.revealedAnswers.clear();
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
      revealed: this.revealedQuestions.has(questionId)
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

  getVoteMode(questionId) {
    return this.questionVoteModes.get(questionId) === 'closed' ? 'closed' : 'open';
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

  createGame({ hostName, hostImageUrl, password }) {
    const game = new Game({
      id: crypto.randomBytes(4).toString('hex'),
      hostToken: crypto.randomUUID(),
      hostName,
      hostImageUrl,
      password
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
    for (const round of pack.rounds) {
      for (const theme of round.themes || []) {
        for (const q of theme.questions || []) {
          if (q && q.id !== undefined) {
            types.set(q.id, q.type || 'normal');
            if (q.type === 'voting') {
              voteModes.set(q.id, q.vote_mode === 'closed' ? 'closed' : 'open');
            }
          }
        }
      }
    }
    game.questionTypes = types;
    game.questionVoteModes = voteModes;
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
