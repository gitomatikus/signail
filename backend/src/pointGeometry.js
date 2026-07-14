const POINT_HINT_RADIUS = 0.12; // 12% of the image's shorter side

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

function createPointHint(point, aspectRatio, random = Math.random) {
  const space = imageSpace(aspectRatio);
  const angle = random() * Math.PI * 2;
  const offset = Math.sqrt(random()) * POINT_HINT_RADIUS;
  const answerX = point.x * space.width;
  const answerY = point.y * space.height;
  const centerX = Math.max(0, Math.min(space.width, answerX + Math.cos(angle) * offset));
  const centerY = Math.max(0, Math.min(space.height, answerY + Math.sin(angle) * offset));
  return {
    x: centerX / space.width,
    y: centerY / space.height,
    radius: POINT_HINT_RADIUS,
  };
}

module.exports = { POINT_HINT_RADIUS, imageSpace, isNormalizedPoint, createPointHint };
