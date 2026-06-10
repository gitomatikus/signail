import config from '../config';
import { indexedDBService } from './indexedDB';

// Drop everything derived from one game's pack/session.
// The user login is kept on purpose - only game data is invalidated.
export const clearLocalGameData = async (gameId) => {
  try {
    await indexedDBService.deletePack(`pack-${gameId}`);
  } catch (error) {
    console.error('Error clearing cached pack:', error);
  }
  localStorage.removeItem(`selectedQuestions-${gameId}`);
  localStorage.removeItem(`currentRoundIndex-${gameId}`);
  localStorage.removeItem(`greenFramedUsers-${gameId}`);
};

// Save the server cache key for a game, clearing local game data when it
// changed. Returns true only when an existing cache was actually invalidated
// (a first visit has nothing stale, so it just stores the key).
export const applyCacheKey = async (gameId, newKey) => {
  if (!newKey) return false;
  const storageKey = `cacheKey-${gameId}`;
  const storedKey = localStorage.getItem(storageKey);
  if (storedKey === newKey) return false;
  await clearLocalGameData(gameId);
  localStorage.setItem(storageKey, newKey);
  return storedKey !== null;
};

// Compare the server cache key with the locally saved one on page load.
// Returns true when the local cache was stale and has been cleared.
export const checkCacheVersion = async (gameId) => {
  try {
    const response = await fetch(`${config.apiUrl}/api/games/${gameId}/cache-key`);
    const result = await response.json();
    if (result.status === 'success' && result.data?.cacheKey) {
      return await applyCacheKey(gameId, result.data.cacheKey);
    }
  } catch (error) {
    console.error('Error checking cache version:', error);
  }
  return false;
};
