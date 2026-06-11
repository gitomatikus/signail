// Host-side preference for how the question page lays out the question and
// answer once both are visible: side by side ('split') or behind tabs
// ('tabs', lets the host test their own knowledge before peeking).
// Stored per device (not per game) and broadcast via a window event so the
// open question page updates without a refresh.
export const HOST_LAYOUT_KEY = 'hostQuestionLayout';
export const HOST_LAYOUT_EVENT = 'host-layout-changed';

export const HOST_LAYOUTS = ['split', 'tabs'];
export const DEFAULT_HOST_LAYOUT = 'split';

export const getHostLayout = () => {
  const stored = localStorage.getItem(HOST_LAYOUT_KEY);
  return HOST_LAYOUTS.includes(stored) ? stored : DEFAULT_HOST_LAYOUT;
};

export const setHostLayout = (layout) => {
  const next = HOST_LAYOUTS.includes(layout) ? layout : DEFAULT_HOST_LAYOUT;
  localStorage.setItem(HOST_LAYOUT_KEY, next);
  window.dispatchEvent(new Event(HOST_LAYOUT_EVENT));
};
