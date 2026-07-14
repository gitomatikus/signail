const test = require('node:test');
const assert = require('node:assert/strict');
const {
  wrapSpectrumPosition,
  clampSpectrumRange,
  normalizeSpectrumConfig,
  createSpectrumTarget,
} = require('./spectrum');

test('wraps positions around both spectrum edges', () => {
  assert.equal(wrapSpectrumPosition(-4), 96);
  assert.equal(wrapSpectrumPosition(104), 4);
  assert.equal(wrapSpectrumPosition(100), 0);
});

test('normalizes authored spectrum settings', () => {
  assert.deepEqual(normalizeSpectrumConfig({
    spectrum_range: 80,
    spectrum_target_mode: 'fixed',
    spectrum_target: -8,
    spectrum_risk_mode: 'safe',
    duration: 0,
  }), {
    range: 50,
    targetMode: 'fixed',
    target: 92,
    riskMode: 'safe',
    clueMode: 'text',
    allowSelfPick: false,
    duration: 60,
  });
  assert.equal(clampSpectrumRange(0), 1);
});

test('fixed targets are stable and random targets cover the circular scale', () => {
  assert.equal(createSpectrumTarget({ targetMode: 'fixed', target: 137 }), 37);
  for (let index = 0; index < 100; index += 1) {
    const target = createSpectrumTarget({ targetMode: 'random' });
    assert.ok(target >= 0 && target < 100);
  }
});
