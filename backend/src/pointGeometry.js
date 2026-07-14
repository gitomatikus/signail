const DEFAULT_POINT_ACCURACY_PERCENT = 2;
const POINT_HINT_RADIUS_MULTIPLIER = 5;
const MAX_POINT_HINT_RADIUS_PERCENT = 40;

function imageSpace(aspectRatio) {
  const aspect = Number(aspectRatio);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return safeAspect >= 1
    ? { width: safeAspect, height: 1 }
    : { width: 1, height: 1 / safeAspect };
}

function isNormalizedPoint(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && value.x >= 0 && value.x <= 1
    && value.y >= 0 && value.y <= 1;
}

function pointHintRadius(accuracyPercent, aspectRatio) {
  const space = imageSpace(aspectRatio);
  const parsedAccuracy = Number(accuracyPercent);
  const safeAccuracy = Number.isFinite(parsedAccuracy) && parsedAccuracy > 0
    ? parsedAccuracy
    : DEFAULT_POINT_ACCURACY_PERCENT;
  const diagonal = Math.hypot(space.width, space.height);
  const correctnessRadius = (safeAccuracy / 100) * diagonal;
  const maximumRadius = (MAX_POINT_HINT_RADIUS_PERCENT / 100) * diagonal;
  return Math.min(correctnessRadius * POINT_HINT_RADIUS_MULTIPLIER, maximumRadius);
}

function createPointHint(point, aspectRatio, accuracyPercent, random = Math.random) {
  const space = imageSpace(aspectRatio);
  const radius = pointHintRadius(accuracyPercent, aspectRatio);
  const angle = random() * Math.PI * 2;
  const offset = Math.sqrt(random()) * radius;
  const answerX = point.x * space.width;
  const answerY = point.y * space.height;
  const centerX = Math.max(0, Math.min(space.width, answerX + Math.cos(angle) * offset));
  const centerY = Math.max(0, Math.min(space.height, answerY + Math.sin(angle) * offset));
  return {
    x: centerX / space.width,
    y: centerY / space.height,
    radius,
  };
}

module.exports = {
  DEFAULT_POINT_ACCURACY_PERCENT,
  POINT_HINT_RADIUS_MULTIPLIER,
  MAX_POINT_HINT_RADIUS_PERCENT,
  imageSpace,
  isNormalizedPoint,
  pointHintRadius,
  createPointHint,
};
