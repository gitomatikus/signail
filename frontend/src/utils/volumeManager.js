// Manage default and user-remembered volume for all video and audio elements
const STORAGE_KEY = 'mediaVolume';
const DEFAULT_VOLUME = 0.39; // 39%

// Get the currently remembered volume or default to 39%
const getRememberedVolume = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) {
    const val = parseFloat(saved);
    if (!isNaN(val) && val >= 0 && val <= 1) {
      return val;
    }
  }
  return DEFAULT_VOLUME;
};

// Set the remembered volume in localStorage
const setRememberedVolume = (val) => {
  localStorage.setItem(STORAGE_KEY, val.toString());
};

// Initialize an audio or video element with the remembered volume
const initializeElement = (el) => {
  if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) {
    return;
  }

  const targetVolume = getRememberedVolume();
  if (el.volume !== targetVolume) {
    el.__programmaticChange = true;
    el.volume = targetVolume;
    el.__programmaticChange = false;
  }
  el.__volumeInitialized = true;
};

// Find and initialize all existing media elements on the page
const initializeExisting = () => {
  const elements = document.querySelectorAll('video, audio');
  elements.forEach((el) => {
    initializeElement(el);
  });
};

// Watch for dynamically added video and audio elements
const setupObserver = () => {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
            initializeElement(node);
          } else {
            const elements = node.querySelectorAll('video, audio');
            elements.forEach((el) => {
              initializeElement(el);
            });
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
};

// Set up capturing event listeners to catch loading, playing, or manual changes
const setupEventListeners = () => {
  // Capture loading/playing events to ensure volume is applied early
  const events = ['play', 'playing', 'loadstart', 'loadedmetadata'];
  events.forEach((eventName) => {
    document.addEventListener(
      eventName,
      (e) => {
        if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
          initializeElement(e.target);
        }
      },
      true
    );
  });

  // Capture volumechange event to update the remembered volume and other media elements
  document.addEventListener(
    'volumechange',
    (e) => {
      const el = e.target;
      if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) {
        return;
      }

      // Ignore programmatic changes to prevent loop feedback
      if (el.__programmaticChange) {
        return;
      }

      const newVolume = el.volume;
      setRememberedVolume(newVolume);

      // Propagate the new volume to all other media elements currently in the DOM
      const elements = document.querySelectorAll('video, audio');
      elements.forEach((otherEl) => {
        if (otherEl !== el) {
          otherEl.__programmaticChange = true;
          otherEl.volume = newVolume;
          otherEl.__programmaticChange = false;
          otherEl.__volumeInitialized = true;
        }
      });
    },
    true
  );
};

// Current remembered volume (for UI controls like the player volume slider)
export const getVolume = () => getRememberedVolume();

// Set the volume for every media element on the page and remember it.
// Used by the player-side slider: players have no native media controls,
// so this is their only way to adjust loudness.
export const setGlobalVolume = (value) => {
  const clamped = Math.min(1, Math.max(0, value));
  setRememberedVolume(clamped);
  document.querySelectorAll('video, audio').forEach((el) => {
    el.__programmaticChange = true;
    el.volume = clamped;
    el.__programmaticChange = false;
    el.__volumeInitialized = true;
  });
};

// Main entry point to initialize the volume manager
export const initVolumeManager = () => {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    initializeExisting();
    setupObserver();
    setupEventListeners();
  }
};
