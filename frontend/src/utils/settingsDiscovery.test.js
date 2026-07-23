import {
  SETTINGS_DISCOVERY_KEY,
  hasOpenedSettings,
  markSettingsOpened,
} from './settingsDiscovery';

describe('settings discovery', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('tracks the first settings visit per account', () => {
    expect(hasOpenedSettings('player-a')).toBe(false);

    markSettingsOpened('player-a');

    expect(hasOpenedSettings('player-a')).toBe(true);
    expect(hasOpenedSettings('player-b')).toBe(false);
    expect(localStorage.getItem(`${SETTINGS_DISCOVERY_KEY}:player-a`)).toBe('true');
  });
});
