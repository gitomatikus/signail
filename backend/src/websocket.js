const WebSocket = require('ws');
const config = require('./config');
const { handleAction } = require('./actions');

// Legacy transport, kept alongside SSE (sse.js) for one release as a rollback
// hatch. Routes every WebSocket connection into its game room (?gameId=...)
// and scopes all message handling and broadcasts to that room. All game logic
// lives in actions.js - this file only owns the socket lifecycle.
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
        // Protocol pings never reach browser JS; this application-level ping
        // does, and feeds the client-side connection watchdog.
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
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
      console.log(`Client connected to game ${game.id}${isHost ? ' (host)' : ''} [ws]`);

      // Current room state so a (re)joining client can catch up immediately
      game.snapshotPayloads().forEach((payload) => {
        ws.send(JSON.stringify(payload));
      });

      ws.on('message', (message) => {
        try {
          // The game may have been deleted while this socket was open
          if (!this.gameManager.getGame(ws.gameId)) return;
          const parsed = JSON.parse(message);
          // Per-connection request only the WS transport needs: SSE clients
          // get the selection set in the connect snapshot instead.
          if (parsed.type === 'request_selected_questions') {
            ws.send(JSON.stringify({
              type: 'selected_questions_update',
              data: Array.from(game.selectedQuestions)
            }));
            return;
          }
          handleAction(game, { isHost: ws.isHost, conn: ws }, parsed.type, parsed.data);
        } catch (error) {
          console.error('Error processing message:', error);
        }
      });

      ws.on('close', () => {
        game.sockets.delete(ws);
        game.handleConnectionClosed(ws);
      });
    });
  }
}

const wsManager = new WebSocketManager();
module.exports = wsManager;
