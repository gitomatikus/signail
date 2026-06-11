const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const wsManager = require('./websocket');
const { GameManager } = require('./games');
const config = require('./config');

const app = express();
const server = http.createServer(app);

const gameManager = new GameManager();
wsManager.initialize(server, gameManager);

// CORS: origins come from CORS_ORIGIN in .env ("*" reflects any origin)
const corsHandler = cors({
  origin: config.allowAllOrigins ? true : config.corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Host-Token'],
  exposedHeaders: ['Content-Length', 'X-Pack-Size']
});

app.use(corsHandler);
app.options('*', corsHandler);

const MAX_PACK_SIZE = 300 * 1024 * 1024;

const requireGame = (req, res) => {
  const game = gameManager.getGame(req.params.gameId);
  if (!game) {
    res.status(404).json({ status: 'error', message: 'Game not found' });
    return null;
  }
  return game;
};

const requireHost = (req, res) => {
  const game = requireGame(req, res);
  if (!game) return null;
  const token = req.headers['x-host-token'] || req.query.hostToken;
  if (token !== game.hostToken) {
    res.status(403).json({ status: 'error', message: 'Only the game host can do this' });
    return null;
  }
  return game;
};

// Pack upload is registered BEFORE express.json so the body is never parsed
// or buffered in memory - it streams straight to the game's pack file.
app.post('/api/games/:gameId/pack', (req, res) => {
  const game = requireHost(req, res);
  if (!game) return;
  if (game.status === 'started') {
    return res.status(409).json({ status: 'error', message: 'Game already started' });
  }

  const fileStream = fs.createWriteStream(game.packPath);
  let received = 0;
  let aborted = false;

  const fail = (status, message) => {
    if (aborted) return;
    aborted = true;
    fileStream.destroy();
    fs.unlink(game.packPath, () => {});
    res.status(status).json({ status: 'error', message });
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_PACK_SIZE) {
      req.destroy();
      fail(413, 'Pack is too large');
    }
  });
  req.on('aborted', () => fail(400, 'Upload aborted'));
  req.pipe(fileStream);

  fileStream.on('error', () => fail(500, 'Failed to save pack'));
  fileStream.on('finish', () => {
    if (aborted) return;
    try {
      // Single transient parse: validates the JSON and builds the small
      // question-type index; the pack itself stays on disk only
      gameManager.indexPackFile(game);
    } catch (e) {
      return fail(400, `Invalid pack: ${e.message}`);
    }
    if (game.status === 'awaiting_pack') {
      game.status = 'lobby';
    }
    const cacheKey = game.regenerateCacheKey();
    game.resetQuestionState();
    game.broadcastGameInfo();
    res.json({
      status: 'success',
      message: 'Pack uploaded successfully',
      data: { gameId: game.id, packName: game.packName, cacheKey }
    });
  });
});

app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({ message: 'Signail game server is running' });
});

// ----- Game list / lifecycle -----

app.get('/api/games', (req, res) => {
  res.json({ status: 'success', data: gameManager.listGames() });
});

app.post('/api/games', (req, res) => {
  const { hostName, hostImageUrl, password } = req.body || {};
  if (!hostName || typeof hostName !== 'string') {
    return res.status(400).json({ status: 'error', message: 'hostName is required' });
  }
  const game = gameManager.createGame({
    hostName: hostName.trim(),
    hostImageUrl: typeof hostImageUrl === 'string' ? hostImageUrl.trim() : '',
    password: typeof password === 'string' && password.length > 0 ? password : null
  });
  res.json({
    status: 'success',
    data: { gameId: game.id, hostToken: game.hostToken }
  });
});

app.get('/api/games/:gameId', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: game.toListInfo() });
});

app.delete('/api/games/:gameId', (req, res) => {
  const game = requireHost(req, res);
  if (!game) return;
  gameManager.deleteGame(game.id, 'deleted by host');
  res.json({ status: 'success', message: 'Game deleted' });
});

// Set, change or remove the game password (host only). Affects new joins;
// players already in the room stay connected.
app.patch('/api/games/:gameId/password', (req, res) => {
  const game = requireHost(req, res);
  if (!game) return;
  const { password } = req.body || {};
  game.password = typeof password === 'string' && password.length > 0 ? password : null;
  game.broadcastGameInfo();
  res.json({ status: 'success', data: { hasPassword: !!game.password } });
});

// Pre-join password check so the client can show a friendly error before
// opening the WebSocket
app.post('/api/games/:gameId/verify', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const { password } = req.body || {};
  if (game.password && password !== game.password) {
    return res.status(403).json({ status: 'error', message: 'Wrong password' });
  }
  res.json({ status: 'success' });
});

// ----- Per-game data -----

// Stream the pack from disk - the server never holds packs in memory
app.get('/api/games/:gameId/pack', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  fs.stat(game.packPath, (err, stat) => {
    if (err) {
      return res.status(404).json({ status: 'error', message: 'Pack not uploaded yet' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Pack-Size', stat.size);
    res.setHeader('Cache-Control', 'no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    const stream = fs.createReadStream(game.packPath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

app.get('/api/games/:gameId/cache-key', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: { cacheKey: game.cacheKey } });
});

app.get('/api/games/:gameId/users', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: Array.from(game.persistentUsers.values()) });
});

app.get('/api/games/:gameId/questions/:questionId/times', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const times = game.getQuestionTimes(parseInt(req.params.questionId));
  res.json({ status: 'success', data: Object.fromEntries(times) });
});

app.get('/api/games/:gameId/questions/:questionId/clicks', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const clicks = game.getQuestionClicks(parseInt(req.params.questionId));
  res.json({ status: 'success', data: Object.fromEntries(clicks) });
});

// Get submissions for a specific question. Before the reveal, other players'
// values are masked as `true`; pass ?userId= to still get your own submitted
// value back after a refresh.
app.get('/api/games/:gameId/questions/:questionId/answers', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const questionId = parseInt(req.params.questionId);
  const requesterId = req.query.userId;
  const info = game.getNumberAnswersInfo(questionId);
  // Choice picks are not masked: the admin shows them in real time
  // (the player UI still hides other players' picks until the reveal)
  const isChoice = game.getQuestionType(questionId) === 'choice';
  const answers = {};
  for (const [userId, value] of info.answers) {
    answers[userId] = info.revealed || isChoice || userId === requesterId ? value : true;
  }
  res.json({
    status: 'success',
    data: { revealed: info.revealed, answers }
  });
});

app.get('/api/games/:gameId/questions/:questionId/secret', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: game.getSecretInfo(parseInt(req.params.questionId)) });
});

app.get('/api/games/:gameId/last-green-frame', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: { userId: game.lastGreenFrameUser } });
});

server.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
