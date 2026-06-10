import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../config';
import { getHostToken, removeHostToken, saveGamePassword } from '../services/gameAuth';

const Avatar = ({ src, alt, size = 40 }) => {
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    objectFit: 'cover',
    border: '2px solid var(--glass-border)',
    background: 'var(--bg-dark)'
  };
  if (!src) return <div style={style} />;
  return src.toLowerCase().endsWith('.mp4')
    ? <video src={src} style={style} autoPlay loop muted playsInline />
    : <img src={src} alt={alt} style={style} onError={e => { e.target.style.visibility = 'hidden'; }} />;
};

// Main page: every running game (one per uploaded pack) with its host and
// pack name. Anyone can join; creators can delete their own games.
const HomePage = ({ user }) => {
  const navigate = useNavigate();
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [passwordPromptGame, setPasswordPromptGame] = useState(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const fetchGames = useCallback(async () => {
    try {
      const response = await fetch(`${config.apiUrl}/api/games`);
      const result = await response.json();
      if (result.status === 'success') {
        setGames(result.data);
        setError('');
      }
    } catch (e) {
      setError('Could not reach the game server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
    const interval = setInterval(fetchGames, 5000);
    return () => clearInterval(interval);
  }, [fetchGames]);

  const handleJoin = (game) => {
    if (getHostToken(game.id)) {
      navigate(`/game/${game.id}`);
      return;
    }
    if (game.hasPassword) {
      setPasswordPromptGame(game);
      setPasswordInput('');
      setPasswordError('');
      return;
    }
    navigate(`/game/${game.id}`);
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    const game = passwordPromptGame;
    try {
      const response = await fetch(`${config.apiUrl}/api/games/${game.id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput })
      });
      if (response.ok) {
        saveGamePassword(game.id, passwordInput);
        navigate(`/game/${game.id}`);
      } else {
        setPasswordError('Wrong password');
      }
    } catch (err) {
      setPasswordError('Could not reach the game server');
    }
  };

  const handleDelete = async (game) => {
    if (!window.confirm(`Delete game "${game.packName}"?`)) return;
    try {
      const response = await fetch(`${config.apiUrl}/api/games/${game.id}`, {
        method: 'DELETE',
        headers: { 'X-Host-Token': getHostToken(game.id) }
      });
      if (response.ok) {
        removeHostToken(game.id);
        fetchGames();
      }
    } catch (err) {
      setError('Could not delete the game');
    }
  };

  return (
    <div className="fade-in" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      minHeight: '100vh',
      padding: '5rem 1rem 2rem'
    }}>
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 className="text-gradient" style={{ fontSize: '3.5rem', fontWeight: 800, margin: 0 }}>SignAil</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Pick a game to join or host your own</p>
        </div>

        <button
          className="btn-primary"
          style={{ alignSelf: 'center', padding: '0.75rem 2.5rem', fontSize: '1.1rem' }}
          onClick={() => navigate('/create')}
        >
          + Create Game
        </button>

        <a
          href={config.packEditorUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            alignSelf: 'center',
            color: 'var(--text-secondary)',
            fontSize: '0.95rem',
            textDecoration: 'none',
            borderBottom: '1px dashed var(--glass-border)'
          }}
        >
          ✏️ Need a pack? Open the pack editor ↗
        </a>

        {error && (
          <div style={{
            padding: '0.75rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '8px',
            color: '#ef4444',
            textAlign: 'center'
          }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>Loading games...</div>
        ) : games.length === 0 ? (
          <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            No games yet. Create the first one!
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {games.map(game => {
              const isMine = !!getHostToken(game.id);
              return (
                <div key={game.id} className="glass-panel" style={{
                  padding: '1rem 1.5rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  flexWrap: 'wrap'
                }}>
                  <Avatar src={game.hostImageUrl} alt={game.hostName} />
                  <div style={{ flex: 1, minWidth: '200px' }}>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1.1rem' }}>
                      {game.hasPassword && <span title="Password protected" style={{ marginRight: '0.4rem' }}>🔒</span>}
                      {game.packName}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                      hosted by <strong>{game.hostName}</strong>
                      {game.packAuthor ? <> · pack by {game.packAuthor}</> : null}
                    </div>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>
                    {game.playerCount} player{game.playerCount === 1 ? '' : 's'}
                    {' · '}
                    <span style={{ color: game.status === 'started' ? '#4ade80' : 'var(--accent)' }}>
                      {game.status === 'started' ? 'in progress' : 'lobby'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn-primary" onClick={() => handleJoin(game)}>
                      {isMine ? 'Open' : 'Join'}
                    </button>
                    {isMine && (
                      <button
                        onClick={() => handleDelete(game)}
                        style={{
                          padding: '0.5rem 1rem',
                          background: 'rgba(239, 68, 68, 0.15)',
                          color: '#ef4444',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          borderRadius: '8px',
                          cursor: 'pointer'
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {passwordPromptGame && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(5px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 99999
        }} onClick={() => setPasswordPromptGame(null)}>
          <form
            className="glass-panel"
            style={{ padding: '2rem', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onClick={e => e.stopPropagation()}
            onSubmit={handlePasswordSubmit}
          >
            <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>
              Password for "{passwordPromptGame.packName}"
            </h3>
            <input
              type="password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              placeholder="Game password"
              autoFocus
            />
            {passwordError && (
              <div style={{ color: '#ef4444', fontSize: '0.875rem', textAlign: 'center' }}>{passwordError}</div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="submit" className="btn-primary" style={{ flex: 1 }}>Join</button>
              <button
                type="button"
                onClick={() => setPasswordPromptGame(null)}
                style={{
                  flex: 1,
                  padding: '0.5rem 1rem',
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '8px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default HomePage;
