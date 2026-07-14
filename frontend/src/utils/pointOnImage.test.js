import {
  DEFAULT_POINT_ACCURACY_PERCENT,
  getImageSpace,
  layoutPointHintLabels,
  pointCorrectnessRadius,
  pointDistancePercent,
  isPointAnswerCorrect,
} from './pointOnImage';

describe('point-on-image geometry', () => {
  test('measures distance as a percentage of the image diagonal', () => {
    expect(pointDistancePercent({ x: 0, y: 0 }, { x: 1, y: 1 }, 2)).toBeCloseTo(100);
    expect(pointDistancePercent({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, 2)).toBeCloseTo(50);
  });

  test('keeps the logical image space aspect-correct', () => {
    expect(getImageSpace(2)).toEqual({ width: 2, height: 1 });
    expect(getImageSpace(0.5)).toEqual({ width: 1, height: 2 });
  });

  test('uses the configured correctness radius', () => {
    const question = {
      correct_point: { x: 0.5, y: 0.5 },
      image_aspect_ratio: 1,
      accuracy_percent: 10,
    };
    expect(isPointAnswerCorrect({ x: 0.6, y: 0.5 }, question)).toBe(true);
    expect(isPointAnswerCorrect({ x: 0.7, y: 0.5 }, question)).toBe(false);
  });

  test('uses 2% by default and exposes the matching visual radius', () => {
    const question = {
      correct_point: { x: 0.5, y: 0.5 },
      image_aspect_ratio: 1,
    };
    expect(DEFAULT_POINT_ACCURACY_PERCENT).toBe(2);
    expect(isPointAnswerCorrect({ x: 0.52, y: 0.5 }, question)).toBe(true);
    expect(isPointAnswerCorrect({ x: 0.54, y: 0.5 }, question)).toBe(false);
    expect(pointCorrectnessRadius(undefined, 2)).toBeCloseTo(0.02 * Math.hypot(2, 1));
  });

  test('keeps full player labels apart when answer zones overlap', () => {
    const labels = layoutPointHintLabels([
      { x: 0.5, y: 0.5, radius: 0.12, label: 'Oleksandr' },
      { x: 0.5, y: 0.5, radius: 0.12, label: 'Anastasiia' },
      { x: 0.5, y: 0.5, radius: 0.12, label: 'Volodymyr' },
    ], { width: 1, height: 1 });

    expect(labels.map(({ label }) => label)).toEqual(['Oleksandr', 'Anastasiia', 'Volodymyr']);
    for (let first = 0; first < labels.length; first += 1) {
      for (let second = first + 1; second < labels.length; second += 1) {
        const a = labels[first];
        const b = labels[second];
        const separated = (
          Math.abs(a.labelX - b.labelX) >= (a.labelWidth + b.labelWidth) / 2
          || Math.abs(a.labelY - b.labelY) >= (a.labelHeight + b.labelHeight) / 2
        );
        expect(separated).toBe(true);
      }
    }
  });
});
