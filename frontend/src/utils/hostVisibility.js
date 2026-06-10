// Player-side preference for showing the host card next to the player list.
// Stored globally (not per game) and broadcast via a window event so open
// components update without a refresh.
export const HIDE_HOST_KEY = 'hideHost';
export const HIDE_HOST_EVENT = 'hide-host-changed';

export const isHostHidden = () => localStorage.getItem(HIDE_HOST_KEY) === 'true';

export const setHostHidden = (hidden) => {
  localStorage.setItem(HIDE_HOST_KEY, hidden ? 'true' : 'false');
  window.dispatchEvent(new Event(HIDE_HOST_EVENT));
};
