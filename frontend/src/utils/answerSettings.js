// Per-device answering preferences, persisted in localStorage like the
// theme and host-layout choices. Read at event time (no subscription
// needed): changing them in Settings applies to the very next keystroke.

// How the text-answer field submits: 'enter' (Shift+Enter for a newline),
// 'ctrl-enter', or 'none' (the Answer button only).
const TEXT_SUBMIT_KEY = 'textAnswerSubmitMode';
export const TEXT_SUBMIT_MODES = ['enter', 'ctrl-enter', 'none'];

export const getTextSubmitMode = () => {
  const value = localStorage.getItem(TEXT_SUBMIT_KEY);
  return TEXT_SUBMIT_MODES.includes(value) ? value : 'enter';
};

export const setTextSubmitMode = (mode) => {
  if (TEXT_SUBMIT_MODES.includes(mode)) {
    localStorage.setItem(TEXT_SUBMIT_KEY, mode);
  }
};

// Single-choice questions: clicking an option submits it right away,
// skipping the "Confirm answer" button. Off by default.
const AUTO_CHOICE_KEY = 'autoSubmitSingleChoice';

export const isAutoSubmitSingleChoice = () =>
  localStorage.getItem(AUTO_CHOICE_KEY) === 'true';

export const setAutoSubmitSingleChoice = (enabled) => {
  localStorage.setItem(AUTO_CHOICE_KEY, enabled ? 'true' : 'false');
};
