export const getImageSpace = (aspectRatio) => {
  const parsed = Number(aspectRatio);
  const aspect = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return aspect >= 1
    ? { width: aspect, height: 1 }
    : { width: 1, height: 1 / aspect };
};

export const DEFAULT_POINT_ACCURACY_PERCENT = 2;

export const pointCorrectnessRadius = (accuracyPercent, aspectRatio) => {
  const parsed = Number(accuracyPercent);
  const safeAccuracy = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_POINT_ACCURACY_PERCENT;
  const space = getImageSpace(aspectRatio);
  return (safeAccuracy / 100) * Math.hypot(space.width, space.height);
};

const overlapArea = (a, b) => {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
};

// Places compact, full-name labels around answer zones. It prefers the centre
// of each zone, then tries surrounding positions and picks the least crowded
// remaining option when every candidate intersects another label.
export const layoutPointHintLabels = (items, imageSpace) => {
  const width = Number(imageSpace?.width) || 1;
  const height = Number(imageSpace?.height) || 1;
  const margin = 0.012;
  const gap = 0.018;
  const placed = [];

  return items.map((item) => {
    const label = String(item.label || '?');
    const x = Math.max(0, Math.min(width, Number(item.x) || 0));
    const y = Math.max(0, Math.min(height, Number(item.y) || 0));
    const radius = Number(item.radius) || 0.12;
    const estimatedUnits = Math.max(2.4, label.length * 0.6 + 1.4);
    const fontSize = Math.max(0.016, Math.min(0.028, (width - margin * 2) / estimatedUnits));
    const labelWidth = Math.min(width - margin * 2, fontSize * estimatedUnits);
    const labelHeight = fontSize * 1.55;
    const horizontalOffset = radius + gap + labelWidth / 2;
    const verticalOffset = radius + gap + labelHeight / 2;
    const diagonalX = radius * 0.72 + gap + labelWidth / 2;
    const diagonalY = radius * 0.72 + gap + labelHeight / 2;
    const rawCandidates = [
      [x, y],
      [x, y - verticalOffset],
      [x, y + verticalOffset],
      [x + horizontalOffset, y],
      [x - horizontalOffset, y],
      [x + diagonalX, y - diagonalY],
      [x - diagonalX, y - diagonalY],
      [x + diagonalX, y + diagonalY],
      [x - diagonalX, y + diagonalY],
    ];

    const candidates = rawCandidates.map(([candidateX, candidateY], index) => {
      const labelX = Math.max(margin + labelWidth / 2, Math.min(width - margin - labelWidth / 2, candidateX));
      const labelY = Math.max(margin + labelHeight / 2, Math.min(height - margin - labelHeight / 2, candidateY));
      const rect = {
        left: labelX - labelWidth / 2,
        right: labelX + labelWidth / 2,
        top: labelY - labelHeight / 2,
        bottom: labelY + labelHeight / 2,
      };
      const overlap = placed.reduce((sum, other) => sum + overlapArea(rect, other), 0);
      return { x: labelX, y: labelY, rect, overlap, index };
    });

    const best = candidates.reduce((current, candidate) => (
      candidate.overlap < current.overlap
        ? candidate
        : current
    ));
    placed.push(best.rect);

    return {
      ...item,
      label,
      labelX: best.x,
      labelY: best.y,
      labelWidth,
      labelHeight,
      fontSize,
      displaced: best.index !== 0 || Math.abs(best.x - x) > 0.001 || Math.abs(best.y - y) > 0.001,
    };
  });
};

// Percentage of the full image diagonal. Coordinates are normalized, while
// the image-space conversion keeps landscape and portrait images geometrically
// correct instead of treating every image as a square.
export const pointDistancePercent = (a, b, aspectRatio) => {
  if (!a || !b) return Infinity;
  const space = getImageSpace(aspectRatio);
  const dx = (Number(a.x) - Number(b.x)) * space.width;
  const dy = (Number(a.y) - Number(b.y)) * space.height;
  if (![dx, dy].every(Number.isFinite)) return Infinity;
  return (Math.hypot(dx, dy) / Math.hypot(space.width, space.height)) * 100;
};

export const isPointAnswerCorrect = (answer, question) =>
  pointDistancePercent(answer, question?.correct_point, question?.image_aspect_ratio)
    <= (Number(question?.accuracy_percent) || DEFAULT_POINT_ACCURACY_PERCENT);
