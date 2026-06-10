import config from '../config';
import { indexedDBService } from './indexedDB';

const CACHE_KEY_STORAGE = 'cacheKey';

// Drop everything derived from the current pack/game session.
// The user login is kept on purpose - only game data is invalidated.
const clearLocalGameData = async () => {
  try {
    await indexedDBService.deletePack('current');
  } catch (error) {
    console.error('Error clearing cached pack:', error);
  }
  localStorage.removeItem('selectedQuestions');
  localStorage.removeItem('currentRoundIndex');
  localStorage.removeItem('greenFramedUsers');
};

// Save the server cache key, clearing local game data when it changed.
// Returns true only when an existing cache was actually invalidated
// (a first visit has nothing stale, so it just stores the key).
export const applyCacheKey = async (newKey) => {
  if (!newKey) return false;
  const storedKey = localStorage.getItem(CACHE_KEY_STORAGE);
  if (storedKey === newKey) return false;
  await clearLocalGameData();
  localStorage.setItem(CACHE_KEY_STORAGE, newKey);
  return storedKey !== null;
};

// Compare the server cache key with the locally saved one on page load.
// Returns true when the local cache was stale and has been cleared.
export const checkCacheVersion = async () => {
  try {
    const response = await fetch(`${config.apiUrl}/api/cache-key`);
    const result = await response.json();
    if (result.status === 'success' && result.data?.cacheKey) {
      return await applyCacheKey(result.data.cacheKey);
    }
  } catch (error) {
    console.error('Error checking cache version:', error);
  }
  return false;
};
