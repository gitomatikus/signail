import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import wsManager from '../utils/websocket';
import { applyCacheKey } from '../services/cacheVersion';
import { getHostToken, getGamePassword } from '../services/gameAuth';
import config from '../config';

const GameContext = createContext(null);

export const useGame = () => useContext(GameContext);

// Connects the current user to one game room and exposes everything the
// game pages need: gameId, host role, game info (lobby/started, host
// name/image), and the live player list.
export const GameProvider = ({ user, children }) => {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [gameInfo, setGameInfo] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [error, setError] = useState(null);

  const hostToken = getHostToken(gameId);
  const isHost = !!hostToken;

  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    // Reject early with a readable error instead of a silently dying socket
    const load = async () => {
      try {
        const response = await fetch(`${config.apiUrl}/api/games/${gameId}`);
        if (response.status === 404) {
          if (!cancelled) setError('Game not found. It may have been deleted.');
          return;
        }
        const result = await response.json();
        if (cancelled || result.status !== 'success') return;
        setGameInfo(result.data);

        wsManager.connect({
          gameId,
          hostToken: getHostToken(gameId),
          password: getGamePassword(gameId)
        });
      } catch (e) {
        if (!cancelled) setError('Could not reach the game server.');
      }
    };
    load();

    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'ws_open') {
        // (Re)introduce ourselves on every (re)connect; the host is not a player
        if (!getHostToken(gameId) && userRef.current) {
          wsManager.sendUserLogin(userRef.current);
        }
      } else if (data.type === 'game_info') {
        setGameInfo(data.data);
      } else if (data.type === 'game_started') {
        setGameInfo(prev => (prev ? { ...prev, status: 'started' } : prev));
      } else if (data.type === 'online_users') {
        setOnlineUsers(data.data);
      } else if (data.type === 'game_not_found' || data.type === 'game_deleted') {
        setError('This game no longer exists.');
        setTimeout(() => navigate('/'), 1500);
      } else if (data.type === 'join_rejected') {
        sessionStorage.removeItem(`gamePassword-${gameId}`);
        setError('Wrong game password.');
        setTimeout(() => navigate('/'), 1500);
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
      wsManager.disconnect();
    };
  }, [gameId, navigate]);

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
        <div style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600 }}>{error}</div>
        <button className="btn-primary" onClick={() => navigate('/')}>Back to games</button>
      </div>
    );
  }

  if (!gameInfo) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div style={{ color: 'var(--text-secondary)' }}>Connecting to game...</div>
      </div>
    );
  }

  return (
    <GameContext.Provider value={{ gameId, isHost, user, gameInfo, onlineUsers, startGame }}>
      {children}
    </GameContext.Provider>
  );
};

export default GameContext;
