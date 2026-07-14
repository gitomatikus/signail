const test = require('node:test');
const assert = require('node:assert/strict');
const { POINT_HINT_RADIUS, imageSpace, isNormalizedPoint, createPointHint } = require('./pointGeometry');

test('validates normalized points', () => {
  assert.equal(isNormalizedPoint({ x: 0, y: 1 }), true);
  assert.equal(isNormalizedPoint({ x: -0.1, y: 0.5 }), false);
  assert.equal(isNormalizedPoint({ x: 0.5, y: 2 }), false);
});

test('creates a stable-size hint containing the exact point', () => {
  const point = { x: 0.42, y: 0.64 };
  const aspect = 2;
  const hint = createPointHint(point, aspect, () => 0.5);
  const space = imageSpace(aspect);
  const distance = Math.hypot(
    (hint.x - point.x) * space.width,
    (hint.y - point.y) * space.height
  );
  assert.equal(hint.radius, POINT_HINT_RADIUS);
  assert.ok(distance <= POINT_HINT_RADIUS);
  assert.ok(hint.x >= 0 && hint.x <= 1);
  assert.ok(hint.y >= 0 && hint.y <= 1);
});
