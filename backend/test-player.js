/* Simulated player: holds an SSE stream open and logs in, so admin-side
   flows can be tested against a real second client.
   Usage: node /app/test-player.js <gameId> [minutes] */
const http = require('http');

const BASE = 'http://localhost:8000';
const gameId = process.argv[2];
const minutes = Number(process.argv[3] || 15);
if (!gameId) {
  console.error('usage: node test-player.js <gameId> [minutes]');
  process.exit(1);
}

const CLIENT_ID = 'sim-player-tab';
const USER = { id: 'sim-p1', name: 'Sim Player', imageUrl: '' };

const req = http.get(`${BASE}/api/games/${gameId}/events?clientId=${CLIENT_ID}`, (res) => {
  console.log('stream open', res.statusCode);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          const msg = JSON.parse(line.slice(5));
          console.log('<<', msg.type);
        } catch (e) { /* padding/ping */ }
      }
    }
  });
  res.on('close', () => {
    console.log('stream closed');
    process.exit(0);
  });

  fetch(`${BASE}/api/games/${gameId}/actions?clientId=${CLIENT_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user_login', data: USER })
  }).then(r => console.log('login', r.status));
});
req.on('error', (e) => { console.error('stream error', e.message); process.exit(1); });

setTimeout(() => process.exit(0), minutes * 60 * 1000);
