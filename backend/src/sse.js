const express = require('express');
const { handleAction } = require('./actions');

// SSE transport:
//   server -> client: GET /api/games/:gameId/events - one long-lived stream
//     per tab, carrying the same { type, data } JSON payloads as the WS
//     messages (as unnamed events, so they land in EventSource.onmessage).
//   client -> server: POST /api/games/:gameId/actions - { type, data } body
//     routed into the shared handleAction switch.
//
// Keepalive is a *named* `ping` event every 15s: it keeps proxies (e.g.
// Cloudflare, which drops a stream after ~100s idle) from treating the stream
// as idle, surfaces dead connections on write, and - unlike an SSE comment
// frame, which never reaches client JS - feeds the client-side watchdog. 15s
// (down from 30s) leaves several flushes of margin under Cloudflare's idle cap.
const KEEPALIVE_INTERVAL_MS = 15000;

class SseManager {
  constructor() {
    this.gameManager = null;
    this.keepaliveTimer = null;
  }

  // Must be registered before the global express.json({ limit: '1mb' }):
  // the actions route mounts its own parser with a higher limit, because a
  // pasted-screenshot answer is a data URL of up to ~8M characters.
  initialize(app, gameManager) {
    this.gameManager = gameManager;

    this.keepaliveTimer = setInterval(() => {
      for (const game of this.gameManager.games.values()) {
        for (const client of game.clients) {
          if (!client.sendPing()) {
            game.removeSseClient(client);
            client.close();
          }
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    app.get('/api/games/:gameId/events', (req, res) => this.handleStream(req, res));
    app.post(
      '/api/games/:gameId/actions',
      express.json({ limit: '10mb' }),
      (req, res) => this.handleActionRequest(req, res)
    );
  }

  handleStream(req, res) {
    const { clientId, hostToken, password } = req.query;
    const game = this.gameManager.getGame(req.params.gameId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Writes to a stream whose peer vanished surface as 'error' events;
    // without a listener they would crash the process
    res.on('error', () => {});
    res.write('retry: 3000\n\n');
    // Cloudflare (and other proxies) buffer the first couple KB of a streamed
    // response before forwarding anything, which delays the snapshot and
    // swallows keepalive pings until the client watchdog gives up and
    // reconnects - the "disconnect every turn" seen through the tunnel but
    // never on the LAN. A one-off padding comment (EventSource ignores `:`
    // lines) pushes past that buffer so the edge starts flushing immediately.
    // Bump the length if pings still arrive batched through a fatter proxy.
    res.write(`:${' '.repeat(2048)}\n\n`);

    const client = {
      res,
      isHost: false,
      clientId: typeof clientId === 'string' && clientId ? clientId : null,
      sendRaw(json) {
        if (res.destroyed || res.writableEnded) return false;
        try {
          res.write(`data: ${json}\n\n`);
          return true;
        } catch (e) {
          return false;
        }
      },
      send(payload) {
        return this.sendRaw(JSON.stringify(payload));
      },
      sendPing() {
        if (res.destroyed || res.writableEnded) return false;
        try {
          res.write('event: ping\ndata: {}\n\n');
          return true;
        } catch (e) {
          return false;
        }
      },
      close() {
        try { res.end(); } catch (e) { /* already gone */ }
      }
    };

    // Rejections still answer 200 + a terminal event: a non-200 response
    // gives EventSource no error detail to show the user
    if (!game) {
      client.send({ type: 'game_not_found', data: { gameId: req.params.gameId } });
      client.close();
      return;
    }
    const isHost = !!hostToken && hostToken === game.hostToken;
    if (!isHost && game.password && password !== game.password) {
      client.send({ type: 'join_rejected', data: { reason: 'wrong_password' } });
      client.close();
      return;
    }
    client.isHost = isHost;

    game.addSseClient(client);
    console.log(`Client connected to game ${game.id}${isHost ? ' (host)' : ''} [sse]`);

    // Current room state so a (re)joining client can catch up immediately
    game.snapshotPayloads().forEach((payload) => client.send(payload));

    // Fires both when the tab disconnects and after we end the stream
    res.on('close', () => {
      game.removeSseClient(client);
    });
  }

  handleActionRequest(req, res) {
    const game = this.gameManager.getGame(req.params.gameId);
    if (!game) {
      return res.status(404).json({ status: 'error', message: 'Game not found' });
    }
    const { type, data } = req.body || {};
    if (typeof type !== 'string' || !type) {
      return res.status(400).json({ status: 'error', message: 'Action type is required' });
    }
    const token = req.headers['x-host-token'];
    const isHost = !!token && token === game.hostToken;
    const conn = game.findSseClient(req.query.clientId);
    // The stream connection already passed the password check; requiring one
    // (or the host token) keeps actions from clients that never joined.
    if (!isHost && !conn) {
      return res.status(403).json({ status: 'error', message: 'Not connected to this game' });
    }
    try {
      handleAction(game, { isHost, conn }, type, data);
    } catch (error) {
      console.error(`Error handling action ${type}:`, error);
      return res.status(500).json({ status: 'error', message: 'Failed to handle action' });
    }
    res.status(204).end();
  }
}

const sseManager = new SseManager();
module.exports = sseManager;
