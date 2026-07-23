import { useCallback, useEffect, useMemo, useState } from 'react';

// Rename this versioned prefix whenever a release adds settings that should be
// introduced to every player again.
export const SETTINGS_DISCOVERY_KEY = 'settingsDiscoveryOpened.v1';

const storageKeyFor = (userId) =>
  userId ? `${SETTINGS_DISCOVERY_KEY}:${userId}` : null;

export const hasOpenedSettings = (userId) => {
  const key = storageKeyFor(userId);
  return key ? localStorage.getItem(key) === 'true' : false;
};

export const markSettingsOpened = (userId) => {
  const key = storageKeyFor(userId);
  if (key) {
    localStorage.setItem(key, 'true');
  }
};

export const useSettingsDiscovery = (userId, enabled = true) => {
  const storageKey = useMemo(() => storageKeyFor(userId), [userId]);
  const [highlightSettings, setHighlightSettings] = useState(false);

  useEffect(() => {
    setHighlightSettings(Boolean(
      enabled
      && storageKey
      && localStorage.getItem(storageKey) !== 'true'
    ));
  }, [enabled, storageKey]);

  const acknowledgeSettings = useCallback(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, 'true');
    }
    setHighlightSettings(false);
  }, [storageKey]);

  return { highlightSettings, acknowledgeSettings };
};
