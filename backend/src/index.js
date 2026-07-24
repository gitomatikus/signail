const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const wsManager = require('./websocket');
const { GameManager } = require('./games');
const config = require('./config');
const { normalizePlayerColor } = require('./profile');

const app = express();
const server = http.createServer(app);

const gameManager = new GameManager();
wsManager.initialize(server, gameManager);

// CORS: origins come from CORS_ORIGIN in .env ("*" reflects any origin)
const corsHandler = cors({
  origin: config.allowAllOrigins ? true : config.corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Host-Token', 'X-Chunk-Index', 'X-Chunk-Count'],
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
//
// Large packs are sent as sequential chunks (Cloudflare caps a single request
// body at 100MB). Each chunk is its own request carrying X-Chunk-Index /
// X-Chunk-Count headers: the first truncates the file, the rest append, and
// only the final chunk triggers validation. A request with no chunk headers is
// treated as a single full upload, so older clients keep working unchanged.
app.post('/api/games/:gameId/pack', (req, res) => {
  const game = requireHost(req, res);
  if (!game) return;
  if (game.status === 'started') {
    return res.status(409).json({ status: 'error', message: 'Game already started' });
  }

  const chunkCount = parseInt(req.headers['x-chunk-count'], 10) || 1;
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10) || 0;
  const isFirst = chunkIndex === 0;
  const isLast = chunkIndex === chunkCount - 1;

  // Reset the running total at the start of a new upload. packUploadBytes
  // accumulates across every chunk so MAX_PACK_SIZE bounds the whole pack,
  // not just one chunk.
  if (isFirst) game.packUploadBytes = 0;

  const fileStream = fs.createWriteStream(game.packPath, { flags: isFirst ? 'w' : 'a' });
  let aborted = false;

  const fail = (status, message) => {
    if (aborted) return;
    aborted = true;
    fileStream.destroy();
    fs.unlink(game.packPath, () => {});
    game.packUploadBytes = 0;
    res.status(status).json({ status: 'error', message });
  };

  req.on('data', (chunk) => {
    game.packUploadBytes += chunk.length;
    if (game.packUploadBytes > MAX_PACK_SIZE) {
      req.destroy();
      fail(413, 'Pack is too large');
    }
  });
  req.on('aborted', () => fail(400, 'Upload aborted'));
  req.pipe(fileStream);

  fileStream.on('error', () => fail(500, 'Failed to save pack'));
  fileStream.on('finish', () => {
    if (aborted) return;
    // Intermediate chunks are now on disk; defer validation until the last one.
    if (!isLast) {
      return res.json({ status: 'success', message: 'Chunk received', data: { partial: true } });
    }
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
  res.json({ message: 'Jeoparty game server is running' });
});

// ----- Game list / lifecycle -----

app.get('/api/games', (req, res) => {
  res.json({ status: 'success', data: gameManager.listGames() });
});

app.post('/api/games', (req, res) => {
  const { hostName, hostImageUrl, hostColor, password, mode, spectrogramClueMode } = req.body || {};
  if (!hostName || typeof hostName !== 'string') {
    return res.status(400).json({ status: 'error', message: 'hostName is required' });
  }
  const game = gameManager.createGame({
    hostName: hostName.trim(),
    hostImageUrl: typeof hostImageUrl === 'string' ? hostImageUrl.trim() : '',
    hostColor: normalizePlayerColor(hostColor),
    password: typeof password === 'string' && password.length > 0 ? password : null,
    mode: mode === 'spectrogram' ? 'spectrogram' : 'quiz',
    spectrogramClueMode: spectrogramClueMode === 'verbal' ? 'verbal' : 'text'
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
  const type = game.getQuestionType(questionId);
  // Live (non-hidden) answers — e.g. choice picks — are not masked: results
  // show in real time (the player UI still hides them until the reveal for
  // hidden questions). Voting is never live for players, only for the host.
  const liveUnmasked = type !== 'voting' && !game.isAnswerHidden(questionId);
  // Voting answers are unmasked for the host (so a refresh restores the live
  // view) but stay masked for players until the reveal
  const hostToken = req.headers['x-host-token'] || req.query.hostToken;
  const votingHostView = type === 'voting' && !!hostToken && hostToken === game.hostToken;
  const answers = {};
  for (const [userId, value] of info.answers) {
    answers[userId] = info.revealed || liveUnmasked || votingHostView || userId === requesterId ? value : true;
  }
  res.json({
    status: 'success',
    data: { revealed: info.revealed, answers }
  });
});

// Point answers have a dedicated representation: before reveal everyone sees
// stable randomized circles, while a player can restore only their own exact
// point. After reveal all exact coordinates are returned.
app.get('/api/games/:gameId/questions/:questionId/point-answers', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const questionId = parseInt(req.params.questionId);
  const requesterId = req.query.userId;
  const info = game.getPointAnswersInfo(questionId);
  const answers = {};
  for (const [userId, point] of info.answers) {
    if (info.revealed || userId === requesterId) answers[userId] = point;
  }
  res.json({
    status: 'success',
    data: {
      revealed: info.revealed,
      answers,
      hints: Object.fromEntries(info.hints)
    }
  });
});

app.get('/api/games/:gameId/questions/:questionId/secret', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: game.getSecretInfo(parseInt(req.params.questionId)) });
});

app.get('/api/games/:gameId/questions/:questionId/crocodile', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: game.getCrocodileInfo(parseInt(req.params.questionId)) });
});

// Timed multi-guess history for text-mode Crocodile. The host can restore all
// live guesses after a refresh; players can restore only their own history
// until the normal answer reveal makes every history public.
app.get('/api/games/:gameId/questions/:questionId/crocodile-guesses', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const questionId = parseInt(req.params.questionId);
  const requesterId = req.query.userId;
  const hostToken = req.headers['x-host-token'] || req.query.hostToken;
  const info = game.getCrocodileGuessesInfo(questionId);
  const canSeeAll = info.revealed || (!!hostToken && hostToken === game.hostToken);
  const guesses = {};
  const counts = {};
  for (const [userId, history] of info.guesses) {
    counts[userId] = history.length;
    if (canSeeAll || userId === requesterId) {
      guesses[userId] = history;
    }
  }
  res.json({
    status: 'success',
    data: { revealed: info.revealed, guesses, counts }
  });
});

// Voting state for a question. Vote targets are masked (as `true`) in closed
// mode until revealed; pass ?userId= to still get your own vote back after a
// refresh. Open mode always returns targets.
app.get('/api/games/:gameId/questions/:questionId/votes', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  const requesterId = req.query.userId;
  const info = game.getVotesInfo(parseInt(req.params.questionId));
  const open = info.voteMode === 'open';
  const votes = {};
  for (const [voterId, targetUserId] of info.votes) {
    votes[voterId] = info.revealed || open || voterId === requesterId ? targetUserId : true;
  }
  res.json({
    status: 'success',
    data: { revealed: info.revealed, voteMode: info.voteMode, votes }
  });
});

app.get('/api/games/:gameId/last-green-frame', (req, res) => {
  const game = requireGame(req, res);
  if (!game) return;
  res.json({ status: 'success', data: { userId: game.lastGreenFrameUser } });
});

server.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
