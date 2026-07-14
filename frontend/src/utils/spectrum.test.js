import {
  buildSpectrumScoreSuggestions,
  getSpectrumMultiplier,
  getSpectrumSegments,
  spectrumDistance,
} from './spectrum';

test('uses circular distance across the two visual edges', () => {
  expect(spectrumDistance(98, 2)).toBe(4);
  expect(spectrumDistance(2, 98)).toBe(4);
});

test('splits the positive range as 20%, 30%, and 50%', () => {
  expect(getSpectrumMultiplier(50, 50, 40)).toBe(1);
  expect(getSpectrumMultiplier(57, 50, 40)).toBe(0.5);
  expect(getSpectrumMultiplier(65, 50, 40)).toBe(0.25);
  expect(getSpectrumMultiplier(75, 50, 40)).toBe(-0.25);
  expect(getSpectrumMultiplier(85, 50, 40)).toBe(-0.5);
  expect(getSpectrumMultiplier(95, 50, 40)).toBe(-1);
});

test('wrapped render segments cover the scale without changing zone widths', () => {
  const segments = getSpectrumSegments(98, 40);
  const widthFor = multiplier => segments
    .filter(segment => segment.multiplier === multiplier)
    .reduce((sum, segment) => sum + segment.end - segment.start, 0);
  expect(segments.reduce((sum, segment) => sum + segment.end - segment.start, 0)).toBeCloseTo(100);
  expect(widthFor(1)).toBeCloseTo(8);
  expect(widthFor(0.5)).toBeCloseTo(12);
  expect(widthFor(0.25)).toBeCloseTo(20);
});

test('suggests the best positive result to the clue giver', () => {
  const result = buildSpectrumScoreSuggestions({
    guesses: { a: 57, b: 65, c: 75 },
    clueGiverId: 'guide',
    target: 50,
    range: 40,
    baseScore: 400,
    riskMode: 'risk',
  });
  expect(result.suggestions).toEqual({ a: 200, b: 100, c: -100, guide: 200 });
});

test('protects players when nobody hits and clamps all losses in safe mode', () => {
  const miss = buildSpectrumScoreSuggestions({
    guesses: { a: 75, b: 85 }, clueGiverId: 'guide', target: 50,
    range: 40, baseScore: 400, riskMode: 'risk',
  });
  expect(miss.suggestions).toEqual({ a: 0, b: 0, guide: -400 });

  const safe = buildSpectrumScoreSuggestions({
    guesses: { a: 57, b: 75 }, clueGiverId: 'guide', target: 50,
    range: 40, baseScore: 400, riskMode: 'safe',
  });
  expect(safe.suggestions).toEqual({ a: 200, b: 0, guide: 200 });
});
