export const DEFAULT_PLAYER_COLOR = '#f97316';

const PLAYER_COLORS = [
  '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#3b82f6',
  '#06b6d4', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f59e0b',
];

export const isValidPlayerColor = (value) => (
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
);

export const getPlayerColor = (userOrId) => {
  const user = userOrId && typeof userOrId === 'object' ? userOrId : { id: userOrId };
  if (isValidPlayerColor(user.color)) return user.color.toLowerCase();

  const identity = String(user.id || user.name || '');
  if (!identity) return DEFAULT_PLAYER_COLOR;
  let hash = 0;
  for (const char of identity) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
};

export const getPlayerAccentFrame = (userOrId, { animated = false } = {}) => {
  const color = getPlayerColor(userOrId);
  return {
    border: `3px solid ${color}`,
    boxShadow: `0 0 24px ${color}99`,
    '--player-identity-color': color,
    ...(animated ? { animation: 'playerIdentityPulse 1.8s ease-in-out infinite' } : {}),
  };
};

export const compactPlayerName = (name, maxLength = 15) => (
  Array.from(String(name || '?')).slice(0, maxLength).join('')
);
