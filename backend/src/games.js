const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PACKS_DIR = path.join(__dirname, '..', 'packs');
const EMPTY_GAME_TTL_MS = 15 * 60 * 1000; // remove a game 15 minutes after the last person left
const SWEEP_INTERVAL_MS = 60 * 1000;

// One running game: lobby metadata + the per-game state that used to be
// global (scores, selections, reveals, times, answers...) + its connections
// (legacy WebSocket sockets and SSE stream clients side by side during the
// transition).
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

    this.sockets = new Set(); // legacy WebSocket connections
    this.clients = new Set(); // SSE stream clients ({ res, isHost, clientId, ... })
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
    this.lastGreenFrameUser = null;
  }

  get packPath() {
    return path.join(PACKS_DIR, `${this.id}.json`);
  }

  hostOnline() {
    for (const ws of this.sockets) {
      if (ws.isHost) return true;
    }
    for (const client of this.clients) {
      if (client.isHost) return true;
    }
    return false;
  }

  connectionCount() {
    return this.sockets.size + this.clients.size;
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
    this.clients.forEach((client) => {
      client.sendRaw(message);
    });
  }

  // The four messages a (re)joining client needs to catch up immediately
  snapshotPayloads() {
    return [
      { type: 'game_info', data: this.toListInfo() },
      { type: 'selected_questions_update', data: Array.from(this.selectedQuestions) },
      { type: 'cache_key_update', data: { cacheKey: this.cacheKey } },
      { type: 'online_users', data: Array.from(this.persistentUsers.values()) }
    ];
  }

  addSseClient(client) {
    // A reconnecting tab reuses its clientId: hand the old stream's presence
    // over to the new one and drop the old quietly - its close event may
    // arrive long after the replacement is already live.
    if (client.clientId) {
      for (const existing of this.clients) {
        if (existing.clientId === client.clientId) {
          this.clients.delete(existing);
          const userData = this.onlineUsers.get(existing);
          if (userData) {
            this.onlineUsers.delete(existing);
            this.onlineUsers.set(client, userData);
          }
          existing.close();
          break;
        }
      }
    }
    this.clients.add(client);
    this.emptySince = null;
    return client;
  }

  removeSseClient(client) {
    if (!this.clients.delete(client)) {
      return; // already evicted by a same-clientId reconnect
    }
    this.handleConnectionClosed(client);
  }

  findSseClient(clientId) {
    if (!clientId) return null;
    for (const client of this.clients) {
      if (client.clientId === clientId) return client;
    }
    return null;
  }

  // Shared disconnect cleanup for both transports.
  handleConnectionClosed(conn) {
    const userData = this.onlineUsers.get(conn);
    if (userData) {
      this.onlineUsers.delete(conn);
      // Another connection (second tab, or the reconnect that replaced this
      // one) may still claim the same user - only without one does the user
      // actually go offline.
      let stillOnline = false;
      for (const u of this.onlineUsers.values()) {
        if (u.id === userData.id) {
          stillOnline = true;
          break;
        }
      }
      if (!stillOnline) {
        this.persistentUsers.delete(userData.id);
      }
      this.broadcastOnlineUsers();
    }
    if (conn.isHost) {
      this.broadcastGameInfo(); // host went offline
    }
    if (this.connectionCount() === 0) {
      this.emptySince = Date.now();
    }
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
    this.questionClicks.clear();
    this.questionAnswers.clear();
    this.revealedAnswers.clear();
    this.broadcastSelectedQuestions();
  }

  getSecretInfo(questionId) {
    return {
      selectorId: this.questionSelectors.get(questionId) || null,
      assignment: this.secretAssignments.get(questionId) || null,
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
    game.clients.forEach(client => client.close());
    fs.unlink(game.packPath, () => {});
    console.log(`Game ${id} removed (${reason})`);
    return true;
  }

  sweepEmptyGames() {
    const now = Date.now();
    for (const game of this.games.values()) {
      if (game.connectionCount() === 0 && game.emptySince && now - game.emptySince > EMPTY_GAME_TTL_MS) {
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
    for (const round of pack.rounds) {
      for (const theme of round.themes || []) {
        for (const q of theme.questions || []) {
          if (q && q.id !== undefined) {
            types.set(q.id, q.type || 'normal');
          }
        }
      }
    }
    game.questionTypes = types;
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
