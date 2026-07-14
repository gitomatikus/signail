const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlayerColor } = require('./profile');

test('normalizes valid profile colors', () => {
  assert.equal(normalizePlayerColor('#A1B2C3'), '#a1b2c3');
});

test('rejects values that are not six-digit hex colors', () => {
  assert.equal(normalizePlayerColor('red'), '');
  assert.equal(normalizePlayerColor('#fff'), '');
  assert.equal(normalizePlayerColor('url(javascript:bad)'), '');
});
