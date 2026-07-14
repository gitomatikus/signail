const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_POINT_HINT_RADIUS_PERCENT,
  POINT_HINT_RADIUS_MULTIPLIER,
  imageSpace,
  isNormalizedPoint,
  pointHintRadius,
  createPointHint,
} = require('./pointGeometry');

test('validates normalized points', () => {
  assert.equal(isNormalizedPoint({ x: 0, y: 1 }), true);
  assert.equal(isNormalizedPoint({ x: -0.1, y: 0.5 }), false);
  assert.equal(isNormalizedPoint({ x: 0.5, y: 2 }), false);
});

test('creates a hint five times the correctness radius and containing the exact point', () => {
  const point = { x: 0.42, y: 0.64 };
  const aspect = 2;
  const accuracyPercent = 2;
  const hint = createPointHint(point, aspect, accuracyPercent, () => 0.5);
  const space = imageSpace(aspect);
  const expectedRadius = (accuracyPercent / 100)
    * Math.hypot(space.width, space.height)
    * POINT_HINT_RADIUS_MULTIPLIER;
  const distance = Math.hypot(
    (hint.x - point.x) * space.width,
    (hint.y - point.y) * space.height
  );
  assert.equal(hint.radius, expectedRadius);
  assert.ok(distance <= expectedRadius);
  assert.ok(hint.x >= 0 && hint.x <= 1);
  assert.ok(hint.y >= 0 && hint.y <= 1);
});

test('caps the hint radius at 40% of the image diagonal', () => {
  const aspect = 2;
  const space = imageSpace(aspect);
  const maximumRadius = (MAX_POINT_HINT_RADIUS_PERCENT / 100)
    * Math.hypot(space.width, space.height);
  assert.equal(pointHintRadius(20, aspect), maximumRadius);
  assert.ok(pointHintRadius(5, aspect) < maximumRadius);
});
