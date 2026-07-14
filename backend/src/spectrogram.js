const crypto = require('crypto');
const pairs = require('./spectrogramPairs.json');
const { createSpectrumTarget, normalizeSpectrumConfig } = require('./spectrum');

const RECENT_PAIR_WINDOW = 24;

function chooseRandom(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[crypto.randomInt(0, items.length)];
}

function chooseSpectrogramPair(recentPairIds = []) {
  const blocked = new Set(recentPairIds);
  const available = pairs.filter(pair => !blocked.has(pair.id));
  return chooseRandom(available.length > 0 ? available : pairs);
}

function createSpectrogramQuestion(pair, roundNumber, clueMode) {
  // Randomly mirroring an axis doubles the useful variation without changing
  // the reviewed pair itself. The target is mirrored with the labels because
  // it is generated only after this question is built.
  const mirrored = crypto.randomInt(0, 2) === 1;
  return {
    id: roundNumber,
    type: 'spectrum',
    spectrum_pair_id: pair.id,
    spectrum_left: mirrored ? pair.right : pair.left,
    spectrum_right: mirrored ? pair.left : pair.right,
    spectrum_range: 20,
    spectrum_target_mode: 'random',
    spectrum_risk_mode: 'risk',
    spectrum_clue_mode: clueMode === 'verbal' ? 'verbal' : 'text',
    spectrum_clue_bonus: 50,
    first_place_bonus: 100,
    allow_self_pick: true,
    duration: 90,
    price: { text: '100', correct: 100, incorrect: -100 },
    rules: [],
    after_round: [],
  };
}

function startSpectrogramRound(game) {
  const players = Array.from(game.persistentUsers.values());
  const clueGiver = chooseRandom(players);
  if (!clueGiver) return null;

  const pair = chooseSpectrogramPair(game.spectrogramRecentPairIds);
  game.spectrogramRoundNumber += 1;
  const question = createSpectrogramQuestion(
    pair,
    game.spectrogramRoundNumber,
    game.spectrogramClueMode
  );
  const config = normalizeSpectrumConfig(question);
  const guessingStartedAt = config.clueMode === 'verbal' ? Date.now() : null;
  const entry = {
    selectorId: null,
    clueGiverId: clueGiver.id,
    target: createSpectrumTarget(config),
    clueMode: config.clueMode,
    clue: null,
    guesses: new Map(),
    guessTimes: new Map(),
    hostGuess: null,
    hostGuessTime: null,
    revealed: false,
    guessingStartedAt,
    guessingEndsAt: config.clueMode === 'verbal'
      ? guessingStartedAt + config.duration * 1000
      : null,
  };

  game.spectrum.clear();
  game.spectrum.set(question.id, entry);
  game.spectrogramRound = { number: game.spectrogramRoundNumber, question };
  game.currentQuestionId = question.id;
  game.spectrogramRecentPairIds.push(pair.id);
  game.spectrogramRecentPairIds = game.spectrogramRecentPairIds.slice(-RECENT_PAIR_WINDOW);
  return game.spectrogramRound;
}

module.exports = {
  pairs,
  chooseSpectrogramPair,
  createSpectrogramQuestion,
  startSpectrogramRound,
};
