const crypto = require('crypto');

function wrapSpectrumPosition(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return ((numeric % 100) + 100) % 100;
}

function clampSpectrumRange(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 20;
  return Math.min(50, Math.max(1, numeric));
}

function normalizeSpectrumConfig(question) {
  const q = question || {};
  return {
    range: clampSpectrumRange(q.spectrum_range),
    targetMode: q.spectrum_target_mode === 'fixed' ? 'fixed' : 'random',
    target: wrapSpectrumPosition(q.spectrum_target),
    riskMode: q.spectrum_risk_mode === 'safe' ? 'safe' : 'risk',
    clueMode: q.spectrum_clue_mode === 'verbal' ? 'verbal' : 'text',
    allowSelfPick: q.allow_self_pick === true,
    duration: Math.min(600, Math.max(1, Number(q.duration) || 60)),
  };
}

function createSpectrumTarget(config) {
  if (config && config.targetMode === 'fixed') {
    return wrapSpectrumPosition(config.target);
  }
  // Six decimal places are plenty for rendering while avoiding Math.random()
  // in authoritative game state.
  return crypto.randomInt(0, 100000000) / 1000000;
}

module.exports = {
  wrapSpectrumPosition,
  clampSpectrumRange,
  normalizeSpectrumConfig,
  createSpectrumTarget,
};
