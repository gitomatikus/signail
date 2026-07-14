import {
  compactPlayerName,
  getPlayerAccentFrame,
  getPlayerColor,
  isValidPlayerColor,
} from './playerIdentity';

describe('player identity helpers', () => {
  test('uses a chosen valid color and normalizes its casing', () => {
    expect(getPlayerColor({ id: 'one', color: '#A1B2C3' })).toBe('#a1b2c3');
    expect(isValidPlayerColor('#a1b2c3')).toBe(true);
    expect(isValidPlayerColor('red')).toBe(false);
  });

  test('gives legacy profiles a stable fallback color', () => {
    expect(getPlayerColor({ id: 'legacy-user' })).toBe(getPlayerColor({ id: 'legacy-user' }));
    expect(getPlayerColor({ id: 'legacy-user' })).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('limits displayed names to the first 15 Unicode characters', () => {
    expect(compactPlayerName('12345678901234567890')).toBe('123456789012345');
    expect(Array.from(compactPlayerName('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀')).length).toBe(15);
  });

  test('builds an optional animated identity frame from the profile color', () => {
    expect(getPlayerAccentFrame({ color: '#123456' })).toEqual({
      border: '3px solid #123456',
      boxShadow: '0 0 24px #12345699',
      '--player-identity-color': '#123456',
    });
    expect(getPlayerAccentFrame({ color: '#123456' }, { animated: true }).animation)
      .toBe('playerIdentityPulse 1.8s ease-in-out infinite');
  });
});
