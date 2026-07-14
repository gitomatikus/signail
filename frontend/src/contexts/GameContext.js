import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import wsManager from '../utils/websocket';
import { applyCacheKey, checkCacheVersion } from '../services/cacheVersion';
import { indexedDBService } from '../services/indexedDB';
import { getHostToken, getGamePassword } from '../services/gameAuth';
import config from '../config';
import { useTranslation } from '../i18n/LanguageContext';
import { normalizeQuestion, hasUserSelection } from '../utils/questionModel';

const GameContext = createContext(null);

export const useGame = () => useContext(GameContext);

// Connects the current user to one game room and exposes everything the
// game pages need: gameId, host role, game info (lobby/started, host
// name/image), and the live player list.
export const GameProvider = ({ user, onUpdateUser, children }) => {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [gameInfo, setGameInfo] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [error, setError] = useState(null);
  const [pack, setPack] = useState(null);
  const [packLoading, setPackLoading] = useState(true);
  const [downloadProgress, setDownloadProgress] = useState(null);
  // The question the room is on at (re)connect time, per the server snapshot.
  // Held until the pack is loaded, then resolved into a navigation below.
  const [pendingQuestionNav, setPendingQuestionNav] = useState(null);
  // Live socket status, used to show a "reconnecting" indicator. Starts true so
  // the indicator only appears after a real drop, not during the initial load
  // (which has its own "Connecting..." screen below).
  const [connected, setConnected] = useState(true);

  const hostToken = getHostToken(gameId);
  const isHost = !!hostToken;

  const userRef = useRef(user);
  const gameInfoRef = useRef(gameInfo);
  // navigate changes identity on every pathname change (non-data router), so
  // the connection effect reads it through a ref - listing it as a dependency
  // would tear down and reconnect the socket on every in-game navigation
  const navigateRef = useRef(navigate);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Profile edits from the header/settings modal: keep AuthWrapper's copy in
  // sync, then push the change over the socket. Players re-announce themselves
  // via user_login; the host sends a dedicated host-profile update.
  const handleUpdateUser = useCallback((updatedData) => {
    if (onUpdateUser) {
      onUpdateUser(updatedData);
    }
    if (!isHost && userRef.current) {
      const updatedUser = { ...userRef.current, ...updatedData };
      wsManager.sendUserLogin(updatedUser);
    } else if (isHost) {
      wsManager.sendUpdateHostProfile(updatedData.name, updatedData.imageUrl, updatedData.color);
      // In Spectrogram the host is also a scored participant.
      if (gameInfoRef.current?.mode === 'spectrogram' && userRef.current) {
        wsManager.sendUserLogin({ ...userRef.current, ...updatedData });
      }
    }
  }, [onUpdateUser, isHost]);

  useEffect(() => {
    gameInfoRef.current = gameInfo;
  }, [gameInfo]);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const loadPack = useCallback(async (info) => {
    if (info?.mode === 'spectrogram') {
      setPack(null);
      setPackLoading(false);
      setDownloadProgress(null);
      return;
    }
    try {
      setPackLoading(true);
      setDownloadProgress(null);
      // If the server rotated the cache key (new pack uploaded / cache
      // cleared), the cached pack and answered questions were just wiped -
      // drop them from state too so we fall through to a fresh fetch.
      // The check and the read run concurrently: the check only decides
      // whether the cached pack may be used, not whether it can be read
      const [cacheChanged, cachedPack] = await Promise.all([
        checkCacheVersion(gameId),
        indexedDBService.getPack(`pack-${gameId}`)
      ]);

      if (cachedPack && !cacheChanged) {
        setPack(cachedPack);
        setPackLoading(false);
        return;
      }

      setDownloadProgress(0);
      const response = await fetch(`${config.apiUrl}/api/games/${gameId}/pack`);
      if (!response.ok) {
        throw new Error('Failed to fetch pack');
      }
      if (!response.body || !window.ReadableStream) {
        const data = await response.json();
        await indexedDBService.savePack({ ...data, id: `pack-${gameId}` });
        setPack(data);
        setPackLoading(false);
        return;
      }
      const contentLength = response.headers.get('X-Pack-Size') || response.headers.get('Content-Length');
      const headerTotal = Number.parseInt(contentLength, 10);
      const total = (Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : null)
        || info?.packSize
        || gameInfoRef.current?.packSize
        || null;
      let loaded = 0;
      let chunks = [];
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        if (total) {
          setDownloadProgress(Math.min(100, Math.round((loaded / total) * 100)));
        } else {
          setDownloadProgress(-1);
        }
      }
      const allChunks = new Uint8Array(chunks.reduce((acc, val) => acc + val.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, offset);
        offset += chunk.length;
      }
      const text = new TextDecoder('utf-8').decode(allChunks);
      const data = JSON.parse(text);
      await indexedDBService.savePack({ ...data, id: `pack-${gameId}` });
      setPack(data);
    } catch (error) {
      console.error('Error loading pack in context:', error);
    } finally {
      setPackLoading(false);
      setDownloadProgress(null);
    }
  }, [gameId]);

  useEffect(() => {
    let cancelled = false;

    // Reject early with a readable error instead of a silently dying socket
    const load = async () => {
      try {
        const response = await fetch(`${config.apiUrl}/api/games/${gameId}`);
        if (response.status === 404) {
          if (!cancelled) setError('game.notFound');
          return;
        }
        const result = await response.json();
        if (cancelled || result.status !== 'success') return;
        gameInfoRef.current = result.data;
        setGameInfo(result.data);

        wsManager.connect({
          gameId,
          hostToken: getHostToken(gameId),
          password: getGamePassword(gameId)
        });

        loadPack(result.data);
      } catch (e) {
        if (!cancelled) setError('game.serverUnreachable');
      }
    };
    load();

    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'ws_open') {
        setConnected(true);
        // (Re)introduce ourselves on every (re)connect. Quiz hosts stay out of
        // the player list; Spectrogram hosts participate and score normally.
        if ((!getHostToken(gameId) || gameInfoRef.current?.mode === 'spectrogram') && userRef.current) {
          wsManager.sendUserLogin(userRef.current);
        }
      } else if (data.type === 'ws_closed') {
        setConnected(false);
      } else if (data.type === 'game_info') {
        gameInfoRef.current = data.data;
        setGameInfo(data.data);
      } else if (data.type === 'game_started') {
        setGameInfo(prev => (prev ? { ...prev, status: 'started' } : prev));
      } else if (data.type === 'online_users') {
        setOnlineUsers(data.data);
      } else if (data.type === 'current_question') {
        // On (re)connect the server tells us which question the room is on, so
        // we can navigate there even if we missed the live select/reveal while
        // disconnected. Resolved once the pack is available (effect below).
        setPendingQuestionNav(data.data);
      } else if (data.type === 'game_not_found' || data.type === 'game_deleted') {
        setError('game.noLongerExists');
        setTimeout(() => navigateRef.current('/'), 1500);
      } else if (data.type === 'join_rejected') {
        sessionStorage.removeItem(`gamePassword-${gameId}`);
        setError('game.wrongPassword');
        setTimeout(() => navigateRef.current('/'), 1500);
      } else if (data.type === 'cache_key_update' && data.data?.cacheKey) {
        if (gameInfoRef.current?.mode === 'spectrogram') return;
        // Server rotated the cache key (new pack uploaded / cache cleared).
        // Drop local caches and reload from the board so everyone picks up
        // the fresh pack and reset question state.
        applyCacheKey(gameId, data.data.cacheKey).then((changed) => {
          if (changed) {
            window.location.href = `/game/${gameId}`;
          }
        });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      wsManager.disconnect();
    };
  }, [gameId, loadPack]);

  // Resolve the server's "current question" snapshot into a navigation. We wait
  // for the pack so we can apply the same rule the live handlers use in
  // GameBoard: the host always follows; a player follows only once the question
  // is revealed or it is a user-selection type (cat-in-the-bag, karaoke,
  // crocodile...). The question page then rehydrates its own per-question state.
  useEffect(() => {
    if (!pendingQuestionNav || !pack) return;
    const { questionId, revealed } = pendingQuestionNav;
    setPendingQuestionNav(null);

    let found = null;
    for (const round of pack.rounds || []) {
      for (const theme of round.themes || []) {
        const q = (theme.questions || []).find(item => item.id === questionId);
        if (q) { found = q; break; }
      }
      if (found) break;
    }
    if (!found) return;

    const userSelection = hasUserSelection(normalizeQuestion(found));
    if (!(isHost || revealed || userSelection)) return;

    const target = `/game/${gameId}/question/${questionId}`;
    if (window.location.pathname !== target) {
      navigateRef.current(target);
    }
  }, [pendingQuestionNav, pack, isHost, gameId]);

  const startGame = useCallback(() => {
    wsManager.sendStartGame();
  }, []);

  if (error) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '1rem'
      }}>
        <div style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600 }}>{t(error)}</div>
        <button className="btn-primary" onClick={() => navigate('/')}>{t('game.backToGames')}</button>
      </div>
    );
  }

  if (!gameInfo) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div style={{ color: 'var(--text-secondary)' }}>{t('game.connecting')}</div>
      </div>
    );
  }

  return (
    <GameContext.Provider value={{ gameId, isHost, user, onUpdateUser: handleUpdateUser, gameInfo, onlineUsers, startGame, pack, packLoading, downloadProgress, loadPack }}>
      {!connected && (
        <div style={{
          position: 'fixed',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99999,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.45rem 0.9rem',
          borderRadius: '999px',
          background: 'rgba(0,0,0,0.78)',
          border: '1px solid var(--glass-border)',
          color: '#fbbf24',
          fontSize: '0.85rem',
          fontWeight: 600,
          boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }}>
          <span style={{
            width: 12,
            height: 12,
            border: '2px solid rgba(251,191,36,0.35)',
            borderTopColor: '#fbbf24',
            borderRadius: '50%',
            display: 'inline-block',
            animation: 'spin 0.8s linear infinite',
          }} />
          {t('game.reconnecting')}
        </div>
      )}
      {children}
    </GameContext.Provider>
  );
};

export default GameContext;
