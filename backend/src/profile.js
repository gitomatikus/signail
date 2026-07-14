const PLAYER_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const normalizePlayerColor = (value, fallback = '') => (
  typeof value === 'string' && PLAYER_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : fallback
);

module.exports = { normalizePlayerColor };
