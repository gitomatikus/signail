const test = require('node:test');
const assert = require('node:assert/strict');
const wsManager = require('./websocket');

const makeGame = () => ({
  spectrum: new Map([[7, {
    selectorId: 'selector',
    clueGiverId: 'guide',
    target: 98,
    clue: 'Mercury',
    guesses: new Map([['player', 4]]),
    revealed: false,
    guessingEndsAt: 12345,
  }]]),
  onlineUsers: new Map(),
  questionSelectors: new Map([[7, 'selector']]),
});

test('spectrum state keeps the target and guesses private before reveal', () => {
  const game = makeGame();
  const guideSocket = {};
  const playerSocket = {};
  const hostSocket = { isHost: true };
  game.onlineUsers.set(guideSocket, { id: 'guide' });
  game.onlineUsers.set(playerSocket, { id: 'player' });

  const guide = wsManager.spectrumStateFor(game, guideSocket, 7);
  const player = wsManager.spectrumStateFor(game, playerSocket, 7);
  const host = wsManager.spectrumStateFor(game, hostSocket, 7);
  assert.equal(guide.target, 98);
  assert.equal(player.target, null);
  assert.equal(host.target, null);
  assert.deepEqual(player.guesses, {});
  assert.equal(player.ownGuess, 4);
});

test('revealed spectrum state publishes target and every marker', () => {
  const game = makeGame();
  game.spectrum.get(7).revealed = true;
  const state = wsManager.spectrumStateFor(game, {}, 7);
  assert.equal(state.target, 98);
  assert.deepEqual(state.guesses, { player: 4 });
  assert.equal(state.phase, 'revealed');
});
