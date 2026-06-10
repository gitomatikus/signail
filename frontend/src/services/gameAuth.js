// Host tokens prove "I created this game" to the server (start/delete/upload).
// They are saved per game in localStorage; game passwords entered when joining
// are kept in sessionStorage so a refresh doesn't ask again.

const HOST_TOKENS_KEY = 'hostTokens';

const readTokens = () => {
  try {
    return JSON.parse(localStorage.getItem(HOST_TOKENS_KEY)) || {};
  } catch (e) {
    return {};
  }
};

export const getHostToken = (gameId) => readTokens()[gameId] || null;

export const saveHostToken = (gameId, token) => {
  const tokens = readTokens();
  tokens[gameId] = token;
  localStorage.setItem(HOST_TOKENS_KEY, JSON.stringify(tokens));
};

export const removeHostToken = (gameId) => {
  const tokens = readTokens();
  delete tokens[gameId];
  localStorage.setItem(HOST_TOKENS_KEY, JSON.stringify(tokens));
};

export const getGamePassword = (gameId) => sessionStorage.getItem(`gamePassword-${gameId}`) || null;

export const saveGamePassword = (gameId, password) => {
  sessionStorage.setItem(`gamePassword-${gameId}`, password);
};
