const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pairs,
  chooseSpectrogramPair,
  createSpectrogramQuestion,
  startSpectrogramRound,
} = require('./spectrogram');

test('spectrogram config contains hundreds of unique, reviewable pairs', () => {
  assert.ok(pairs.length >= 200);
  assert.equal(new Set(pairs.map(pair => pair.id)).size, pairs.length);
  pairs.forEach(pair => {
    assert.equal(typeof pair.left, 'string');
    assert.equal(typeof pair.right, 'string');
    assert.ok(pair.left.trim());
    assert.ok(pair.right.trim());
    assert.notEqual(pair.left, pair.right);
  });
});

test('pair selection avoids the recent window when alternatives exist', () => {
  const selected = chooseSpectrogramPair(pairs.slice(0, 24).map(pair => pair.id));
  assert.ok(selected);
  assert.ok(!pairs.slice(0, 24).some(pair => pair.id === selected.id));
});

test('a round picks a participant and creates the configured clue phase', () => {
  const game = {
    persistentUsers: new Map([
      ['a', { id: 'a', name: 'A' }],
      ['b', { id: 'b', name: 'B' }],
    ]),
    spectrogramRecentPairIds: [],
    spectrogramRoundNumber: 0,
    spectrogramClueMode: 'text',
    spectrum: new Map(),
    currentQuestionId: null,
  };

  const round = startSpectrogramRound(game);
  assert.equal(round.number, 1);
  assert.equal(round.question.type, 'spectrum');
  assert.equal(round.question.spectrum_clue_mode, 'text');
  assert.equal(round.question.spectrum_risk_mode, 'risk');
  assert.equal(round.question.price.incorrect, -100);
  assert.ok(['a', 'b'].includes(game.spectrum.get(round.question.id).clueGiverId));
  assert.equal(game.spectrum.get(round.question.id).guessingStartedAt, null);
});

test('verbal questions start guessing immediately', () => {
  const question = createSpectrogramQuestion(pairs[0], 7, 'verbal');
  assert.equal(question.id, 7);
  assert.equal(question.spectrum_clue_mode, 'verbal');
});
