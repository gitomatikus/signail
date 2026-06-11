// Player-selectable visual themes. Each id matches an html[data-theme="..."]
// block in index.css; the choice is per-device (localStorage), not synced.
export const THEMES = [
  { id: 'party', name: 'Party Mix' },
  { id: 'neon', name: 'Neon Arcade' },
  { id: 'tidepool', name: 'Tide Pool' },
  { id: 'cardtable', name: 'Card Table' },
  { id: 'royal', name: 'Royal Court' },
  { id: 'daylight', name: 'Daylight' },
];

export const DEFAULT_THEME = 'party';
const STORAGE_KEY = 'theme';

export const getTheme = () => {
  const stored = localStorage.getItem(STORAGE_KEY);
  return THEMES.some(t => t.id === stored) ? stored : DEFAULT_THEME;
};

export const applyTheme = (id) => {
  const theme = THEMES.some(t => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
};

// Set the attribute before first paint so there is no theme flash
export const initTheme = () => {
  document.documentElement.dataset.theme = getTheme();
};
