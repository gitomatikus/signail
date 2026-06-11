/* One-shot smoke test for the SSE transport + WS dual-write.
   Run inside the backend container: node /app/test-sse.js */
const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://localhost:8000';
const results = [];
let failures = 0;
const check = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures++;
};
setTimeout(() => { flush(); console.error('GLOBAL TIMEOUT'); process.exit(2); }, 100000);
const flush = () => console.log(results.join('\n'));

const post = (path, body, headers = {}) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

// Minimal SSE client that parses frames into { event, data, parsed }
function openStream(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, (res) => {
      const client = {
        status: res.statusCode,
        events: [],
        listeners: new Set(),
        closed: false,
        close: () => req.destroy(),
        waitFor(pred, timeoutMs = 5000) {
          return new Promise((res2, rej2) => {
            const found = this.events.find(pred);
            if (found) return res2(found);
            const listener = (ev) => {
              if (pred(ev)) {
                clearTimeout(t);
                this.listeners.delete(listener);
                res2(ev);
              }
            };
            const t = setTimeout(() => {
              this.listeners.delete(listener);
              rej2(new Error(`timeout waiting on ${path}`));
            }, timeoutMs);
            this.listeners.add(listener);
          });
        },
        waitClosed(timeoutMs = 5000) {
          return new Promise((res2, rej2) => {
            if (this.closed) return res2();
            this.onClosed = () => { clearTimeout(t); res2(); };
            const t = setTimeout(() => rej2(new Error('timeout waiting for stream close')), timeoutMs);
          });
        }
      };
      const markClosed = () => {
        if (client.closed) return;
        client.closed = true;
        if (client.onClosed) client.onClosed();
      };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: 'message', data: null, retry: null, parsed: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
            else if (line.startsWith('retry:')) ev.retry = line.slice(6).trim();
          }
          if (ev.data !== null && ev.event === 'message') {
            try { ev.parsed = JSON.parse(ev.data); } catch (e) { /* not json */ }
          }
          client.events.push(ev);
          [...client.listeners].forEach(l => l(ev));
        }
      });
      res.on('end', markClosed);
      res.on('close', markClosed);
      res.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
  });
}

(async () => {
  // --- setup: game + pack ---
  const created = await (await post('/api/games', { hostName: 'TestHost' })).json();
  const { gameId, hostToken } = created.data;
  check('create game', !!gameId && !!hostToken);

  const pack = {
    name: 'SSE Test Pack',
    author: 'tester',
    rounds: [{ name: 'R1', themes: [{ name: 'T1', questions: [
      { id: 1, type: 'text-answer', rules: [] },
      { id: 2, type: 'choice', options: [], rules: [] },
      { id: 3, rules: [] }
    ] }] }]
  };
  const packRes = await fetch(`${BASE}/api/games/${gameId}/pack`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(pack)
  });
  check('upload pack', packRes.ok);

  // --- host SSE stream: snapshot ---
  const host = await openStream(`/api/games/${gameId}/events?clientId=host-tab&hostToken=${hostToken}`);
  await host.waitFor(e => e.parsed?.type === 'online_users');
  const snapshotTypes = host.events.filter(e => e.parsed).map(e => e.parsed.type);
  check('snapshot has 4 room events',
    ['game_info', 'selected_questions_update', 'cache_key_update', 'online_users'].every(t => snapshotTypes.includes(t)),
    snapshotTypes.join(','));
  check('stream is 200', host.status === 200);
  check('retry hint sent', host.events.some(e => e.retry === '3000'));
  const info = host.events.find(e => e.parsed?.type === 'game_info').parsed.data;
  check('hostOnline true over sse', info.hostOnline === true);

  // --- player SSE stream + legacy WS client side by side ---
  const player = await openStream(`/api/games/${gameId}/events?clientId=player-tab`);
  await player.waitFor(e => e.parsed?.type === 'online_users');

  const ws = new WebSocket(`ws://localhost:8000/ws?gameId=${gameId}`);
  const wsMsgs = [];
  ws.on('message', (m) => { try { wsMsgs.push(JSON.parse(m)); } catch (e) {} });
  const waitWs = (pred, ms = 5000) => new Promise((res, rej) => {
    const found = wsMsgs.find(pred);
    if (found) return res(found);
    const t = setTimeout(() => rej(new Error('ws timeout')), ms);
    ws.on('message', function handler(m) {
      let d; try { d = JSON.parse(m); } catch (e) { return; }
      if (pred(d)) { clearTimeout(t); ws.off('message', handler); res(d); }
    });
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await waitWs(d => d.type === 'online_users');
  check('legacy ws still connects + snapshot', true);

  // --- presence via actions POST ---
  const login = await post(`/api/games/${gameId}/actions?clientId=player-tab`,
    { type: 'user_login', data: { id: 'u1', name: 'Player One', imageUrl: '' } });
  check('user_login action 204', login.status === 204);
  await player.waitFor(e => e.parsed?.type === 'online_users' && e.parsed.data.some(u => u.id === 'u1'));
  check('login broadcast on sse', true);
  await waitWs(d => d.type === 'online_users' && d.data.some(u => u.id === 'u1'));
  check('login broadcast on ws (dual write)', true);

  // --- auth gate on actions ---
  const noAuth = await post(`/api/games/${gameId}/actions?clientId=stranger`, { type: 'start_game' });
  check('unknown clientId rejected', noAuth.status === 403);
  const playerStart = await post(`/api/games/${gameId}/actions?clientId=player-tab`, { type: 'start_game' });
  check('non-host start_game is a no-op', playerStart.status === 204);
  let gameInfoNow = await (await fetch(`${BASE}/api/games/${gameId}`)).json();
  check('still in lobby', gameInfoNow.data.status === 'lobby');

  // --- host actions ---
  const start = await post(`/api/games/${gameId}/actions?clientId=host-tab`, { type: 'start_game' }, { 'X-Host-Token': hostToken });
  check('host start_game 204', start.status === 204);
  await player.waitFor(e => e.parsed?.type === 'game_started');
  check('game_started broadcast', true);

  await post(`/api/games/${gameId}/actions?clientId=host-tab`,
    { type: 'question_select', data: { questionId: 1, userType: 'admin', userId: null } }, { 'X-Host-Token': hostToken });
  await player.waitFor(e => e.parsed?.type === 'selected_questions_update' && e.parsed.data.includes(1));
  check('question_select -> selection broadcast', true);

  // --- big pasted-image answer (route-level 10mb json limit) ---
  const big = 'data:image/png;base64,' + 'A'.repeat(7000000);
  const answer = await post(`/api/games/${gameId}/actions?clientId=player-tab`,
    { type: 'number_answer', data: { questionId: 1, userId: 'u1', value: big } });
  check('7MB answer accepted', answer.status === 204);
  const submitted = await host.waitFor(e => e.parsed?.type === 'number_answer_submitted' && e.parsed.data.questionId === 1);
  check('submission broadcast masked', submitted.parsed.data.userId === 'u1' && submitted.parsed.data.value === undefined);
  const answers = await (await fetch(`${BASE}/api/games/${gameId}/questions/1/answers?userId=u1`)).json();
  check('own answer readable over REST', answers.data.answers.u1 === big);

  await post(`/api/games/${gameId}/actions?clientId=host-tab`,
    { type: 'reveal_number_answers', data: { questionId: 1 } }, { 'X-Host-Token': hostToken });
  const reveal = await player.waitFor(e => e.parsed?.type === 'number_answers');
  check('reveal broadcast carries values', reveal.parsed.data.answers.u1 === big);

  // --- same-clientId reconnect hands presence over ---
  const player2 = await openStream(`/api/games/${gameId}/events?clientId=player-tab`);
  const snap2 = await player2.waitFor(e => e.parsed?.type === 'online_users');
  check('reconnect snapshot still lists user', snap2.parsed.data.some(u => u.id === 'u1'));
  await player.waitClosed();
  check('old stream evicted on reconnect', player.closed);
  await new Promise(r => setTimeout(r, 300));
  const users = await (await fetch(`${BASE}/api/games/${gameId}/users`)).json();
  check('user survives same-tab reconnect', users.data.some(u => u.id === 'u1'));

  // --- closing the live stream logs the user out ---
  player2.close();
  await waitWs(d => d.type === 'online_users' && !d.data.some(u => u.id === 'u1'));
  check('disconnect drops user presence', true);

  // --- soft rejections over a 200 stream ---
  const pw = await (await post('/api/games', { hostName: 'PwHost', password: 'secret' })).json();
  const rejected = await openStream(`/api/games/${pw.data.gameId}/events?clientId=x`);
  const rejEv = await rejected.waitFor(e => e.parsed?.type === 'join_rejected');
  check('join_rejected over 200 stream', rejected.status === 200 && rejEv.parsed.data.reason === 'wrong_password');
  await rejected.waitClosed();
  check('rejected stream ends', true);
  const okPw = await openStream(`/api/games/${pw.data.gameId}/events?clientId=y&password=secret`);
  await okPw.waitFor(e => e.parsed?.type === 'online_users');
  check('correct password joins', true);
  okPw.close();
  const missing = await openStream('/api/games/nope/events?clientId=x');
  await missing.waitFor(e => e.parsed?.type === 'game_not_found');
  check('game_not_found over 200 stream', true);
  await fetch(`${BASE}/api/games/${pw.data.gameId}`, { method: 'DELETE', headers: { 'X-Host-Token': pw.data.hostToken } });

  // --- keepalive: named ping on sse, app-level ping on ws (~30s) ---
  await host.waitFor(e => e.event === 'ping', 35000);
  check('sse named ping within 35s', true);
  await waitWs(d => d.type === 'ping', 35000);
  check('ws app-level ping within 35s', true);

  // --- delete game: broadcast + stream teardown ---
  const del = await fetch(`${BASE}/api/games/${gameId}`, { method: 'DELETE', headers: { 'X-Host-Token': hostToken } });
  check('delete game', del.ok);
  await host.waitFor(e => e.parsed?.type === 'game_deleted', 3000);
  check('game_deleted broadcast', true);
  await host.waitClosed();
  check('stream closed on delete', true);

  flush();
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  flush();
  console.error('TEST CRASH:', e);
  process.exit(1);
});
