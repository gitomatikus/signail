export const SPECTRUM_ZONE_COLORS = {
  1: '#22c55e',
  0.5: '#84cc16',
  0.25: '#d4d84f',
  '-0.25': '#facc15',
  '-0.5': '#f97316',
  '-1': '#ef4444',
};

export const SPECTRUM_ZONE_MULTIPLIERS = [1, 0.5, 0.25, -0.25, -0.5, -1];

export const formatSpectrumPoints = (multiplier, baseScore, riskMode = 'risk') => {
  const points = riskMode === 'safe' && Number(multiplier) < 0
    ? 0
    : Math.round(Math.abs(Number(baseScore) || 0) * Number(multiplier));
  return `${points > 0 ? '+' : ''}${points}`;
};

export const wrapSpectrumPosition = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return ((numeric % 100) + 100) % 100;
};

export const clampSpectrumRange = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 20;
  return Math.min(50, Math.max(1, numeric));
};

export const spectrumDistance = (position, target) => {
  const direct = Math.abs(wrapSpectrumPosition(position) - wrapSpectrumPosition(target));
  return Math.min(direct, 100 - direct);
};

export const getSpectrumBands = (rangeValue) => {
  const range = clampSpectrumRange(rangeValue);
  const positiveRadius = range / 2;
  const negativeWidth = (50 - positiveRadius) / 3;
  return [
    { inner: 0, outer: range * 0.10, multiplier: 1 },
    { inner: range * 0.10, outer: range * 0.25, multiplier: 0.5 },
    { inner: range * 0.25, outer: positiveRadius, multiplier: 0.25 },
    { inner: positiveRadius, outer: positiveRadius + negativeWidth, multiplier: -0.25 },
    { inner: positiveRadius + negativeWidth, outer: positiveRadius + negativeWidth * 2, multiplier: -0.5 },
    { inner: positiveRadius + negativeWidth * 2, outer: 50, multiplier: -1 },
  ];
};

export const getSpectrumMultiplier = (position, target, rangeValue) => {
  const distance = spectrumDistance(position, target);
  const bands = getSpectrumBands(rangeValue);
  return bands.find((band, index) => (
    index === 0 ? distance <= band.outer : distance > band.inner && distance <= band.outer
  ))?.multiplier ?? -1;
};

const splitWrappedInterval = (start, end, meta) => {
  const length = end - start;
  if (length <= 0) return [];
  const normalizedStart = wrapSpectrumPosition(start);
  const normalizedEnd = normalizedStart + length;
  if (normalizedEnd <= 100) {
    return [{ start: normalizedStart, end: normalizedEnd, ...meta }];
  }
  return [
    { start: normalizedStart, end: 100, ...meta },
    { start: 0, end: normalizedEnd - 100, ...meta },
  ];
};

// Converts the six circular distance bands into ordinary 0..100 intervals.
// A band crossing either edge is returned as two rectangles.
export const getSpectrumSegments = (targetValue, rangeValue, baseScore = 100, riskMode = 'risk') => {
  const target = wrapSpectrumPosition(targetValue);
  const segments = [];
  getSpectrumBands(rangeValue).forEach((band) => {
    const key = String(band.multiplier);
    const meta = {
      multiplier: band.multiplier,
      color: SPECTRUM_ZONE_COLORS[key],
      label: formatSpectrumPoints(band.multiplier, baseScore, riskMode),
    };
    if (band.inner === 0) {
      segments.push(...splitWrappedInterval(target - band.outer, target + band.outer, meta));
    } else {
      segments.push(...splitWrappedInterval(target - band.outer, target - band.inner, meta));
      segments.push(...splitWrappedInterval(target + band.inner, target + band.outer, meta));
    }
  });
  return segments
    .filter(segment => segment.end - segment.start > 0.000001)
    .sort((a, b) => a.start - b.start);
};

export const buildSpectrumScoreSuggestions = ({
  guesses = {},
  clueGiverId,
  target,
  range,
  baseScore,
  riskMode = 'risk',
  guessTimes = {},
  firstCorrectBonus = 0,
  clueGiverCorrectBonus = 0,
  hostGuess = null,
}) => {
  const base = Math.abs(Number(baseScore)) || 0;
  const entries = Object.entries(guesses).filter(([, position]) => Number.isFinite(Number(position)));
  const multipliers = Object.fromEntries(entries.map(([userId, position]) => [
    userId,
    getSpectrumMultiplier(Number(position), target, range),
  ]));
  const hostMultiplier = hostGuess !== null && Number.isFinite(Number(hostGuess))
    ? getSpectrumMultiplier(Number(hostGuess), target, range)
    : null;
  const positiveValues = [
    ...Object.values(multipliers).filter(value => value > 0),
    ...(hostMultiplier > 0 ? [hostMultiplier] : []),
  ];
  const hasPositiveGuess = positiveValues.length > 0;
  const safe = riskMode === 'safe';
  const suggestions = {};
  const correctUserIds = entries
    .filter(([userId]) => multipliers[userId] > 0)
    .map(([userId]) => userId)
    .sort((left, right) => (Number(guessTimes[left]) || 0) - (Number(guessTimes[right]) || 0));
  const firstCorrectUserId = correctUserIds[0] || null;
  const correctGuessCount = correctUserIds.length + (hostMultiplier > 0 ? 1 : 0);
  const firstBonus = Math.max(0, Number(firstCorrectBonus) || 0);
  const clueBonus = Math.max(0, Number(clueGiverCorrectBonus) || 0);

  entries.forEach(([userId]) => {
    const raw = Math.round(base * multipliers[userId]);
    suggestions[userId] = safe ? Math.max(0, raw) : raw;
  });

  if (firstCorrectUserId) {
    suggestions[firstCorrectUserId] += firstBonus;
  }

  if (clueGiverId) {
    suggestions[clueGiverId] = hasPositiveGuess
      ? Math.round(base * Math.max(...positiveValues)) + Math.max(0, correctGuessCount - 1) * clueBonus
      : (safe ? 0 : -base);
  }

  return { suggestions, multipliers, hostMultiplier, hasPositiveGuess, firstCorrectUserId, correctCount: correctGuessCount };
};
