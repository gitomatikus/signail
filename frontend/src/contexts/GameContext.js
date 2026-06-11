import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import realtimeManager from '../utils/realtime';
import { applyCacheKey, checkCacheVersion } from '../services/cacheVersion';
import { indexedDBService } from '../services/indexedDB';
import { getHostToken, getGamePassword } from '../services/gameAuth';
import config from '../config';
import { useTranslation } from '../i18n/LanguageContext';

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
  // True between a detected stream death and the next successful (re)open -
  // drives the "reconnecting" banner and lets pages hold their fire
  const [connectionLost, setConnectionLost] = useState(false);
  const [pack, setPack] = useState(null);
  const [packLoading, setPackLoading] = useState(true);
  const [downloadProgress, setDownloadProgress] = useState(null);

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

  const handleUpdateUser = useCallback((updatedData) => {
    if (onUpdateUser) {
      onUpdateUser(updatedData);
    }
    if (!isHost && userRef.current) {
      const updatedUser = { ...userRef.current, ...updatedData };
      realtimeManager.sendUserLogin(updatedUser);
    } else if (isHost) {
      realtimeManager.sendUpdateHostProfile(updatedData.name, updatedData.imageUrl);
    }
  }, [onUpdateUser, isHost]);
  useEffect(() => {
    gameInfoRef.current = gameInfo;
  }, [gameInfo]);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const loadPack = useCallback(async (info) => {
    try {
      setPackLoading(true);
      setDownloadProgress(null);
      // If the server rotated the cache key (new pack uploaded / cache
      // cleared), the cached pack and answered questions were just wiped -
      // drop them from state too so we fall through to a fresh fetch
      const cacheChanged = await checkCacheVersion(gameId);
      const cachedPack = await indexedDBService.getPack(`pack-${gameId}`);

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

        realtimeManager.connect({
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

    const unsubscribe = realtimeManager.subscribe((data) => {
      if (data.type === 'ws_open') {
        setConnectionLost(false);
        // (Re)introduce ourselves on every (re)connect; the host is not a player
        if (!getHostToken(gameId) && userRef.current) {
          realtimeManager.sendUserLogin(userRef.current);
        }
      } else if (data.type === 'connection_lost') {
        setConnectionLost(true);
      } else if (data.type === 'game_info') {
        gameInfoRef.current = data.data;
        setGameInfo(data.data);
      } else if (data.type === 'game_started') {
        setGameInfo(prev => (prev ? { ...prev, status: 'started' } : prev));
      } else if (data.type === 'online_users') {
        setOnlineUsers(data.data);
      } else if (data.type === 'game_not_found' || data.type === 'game_deleted') {
        setError('game.noLongerExists');
        setTimeout(() => navigateRef.current('/'), 1500);
      } else if (data.type === 'join_rejected') {
        sessionStorage.removeItem(`gamePassword-${gameId}`);
        setError('game.wrongPassword');
        setTimeout(() => navigateRef.current('/'), 1500);
      } else if (data.type === 'cache_key_update' && data.data?.cacheKey) {
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
      realtimeManager.disconnect();
    };
  }, [gameId, loadPack]);

  const startGame = useCallback(() => {
    realtimeManager.sendStartGame();
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
    <GameContext.Provider value={{ gameId, isHost, user, onUpdateUser: handleUpdateUser, gameInfo, onlineUsers, startGame, pack, packLoading, downloadProgress, loadPack, connectionLost }}>
      {connectionLost && (
        <div style={{
          position: 'fixed',
          top: '0.75rem',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100000,
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          padding: '0.5rem 1.25rem',
          borderRadius: '999px',
          background: 'var(--bg-dark)',
          border: '1px solid #fbbf24',
          boxShadow: '0 0 20px rgba(251, 191, 36, 0.35)',
          color: '#fbbf24',
          fontWeight: 600,
          fontSize: '0.95rem'
        }}>
          <span style={{
            width: 14,
            height: 14,
            border: '2px solid rgba(251, 191, 36, 0.35)',
            borderTopColor: '#fbbf24',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
          {t('game.reconnecting')}
        </div>
      )}
      {children}
    </GameContext.Provider>
  );
};

export default GameContext;
