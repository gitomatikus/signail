import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../config';
import { getHostToken, removeHostToken, saveGamePassword } from '../services/gameAuth';
import { useTranslation } from '../i18n/LanguageContext';
import Logo from '../components/Logo';

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
// pack name. Anyone can browse; joining, creating and deleting games require
// a profile — logged-out visitors see the list with a big login CTA instead.
const HomePage = ({ user, onRequestLogin }) => {
  const navigate = useNavigate();
  const { t, tp, translateMessage } = useTranslation();
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
      setError('home.serverUnreachable');
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
        setPasswordError('home.wrongPassword');
      }
    } catch (err) {
      setPasswordError('home.serverUnreachable');
    }
  };

  const handleDelete = async (game) => {
    if (!window.confirm(t('home.deleteConfirm', { name: game.packName }))) return;
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
      setError('home.couldNotDelete');
    }
  };

  return (
    <div className="fade-in mobile-page home-page" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      minHeight: '100vh',
      padding: '5rem 1rem 2rem'
    }}>
      <div style={{ width: '100%', maxWidth: '800px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Logo />
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{t('home.tagline')}</p>
        </div>

        {user ? (
          <button
            className="btn-primary"
            style={{ alignSelf: 'center', padding: '0.75rem 2.5rem', fontSize: '1.1rem' }}
            onClick={() => navigate('/create')}
          >
            {t('home.createGame')}
          </button>
        ) : (
          <div style={{
            alignSelf: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.75rem'
          }}>
            <div style={{ color: 'var(--text-primary)', fontSize: '1.15rem' }}>
              {t('home.loginToJoin')}
            </div>
            <button
              className="btn-primary"
              style={{ padding: '1rem 4rem', fontSize: '1.3rem' }}
              onClick={onRequestLogin}
            >
              {t('home.logIn')}
            </button>
          </div>
        )}

        <a
          className="home-editor-link"
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
          {t('home.packEditorLink')}
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
            {translateMessage(error)}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>{t('home.loadingGames')}</div>
        ) : games.length === 0 ? (
          <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
            {t('home.noGames')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {games.map(game => {
              const isMine = !!getHostToken(game.id);
              return (
                <div key={game.id} className="glass-panel card-hover home-game-card" style={{
                  padding: '1rem 1.5rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  flexWrap: 'wrap'
                }}>
                  <Avatar src={game.hostImageUrl} alt={game.hostName} />
                  <div className="home-game-card__body" style={{ flex: 1, minWidth: '200px' }}>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1.1rem' }}>
                      {game.hasPassword && <span title={t('home.passwordProtected')} style={{ marginRight: '0.4rem' }}>🔒</span>}
                      {game.mode === 'spectrogram' && <span title={t('create.spectrogramTab')} style={{ marginRight: '0.4rem' }}>🌈</span>}
                      {game.packName}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                      {t('home.hostedBy')} <strong>{game.hostName}</strong>
                      {game.packAuthor ? <> · {t('home.packBy')} {game.packAuthor}</> : null}
                    </div>
                  </div>
                  <div className="home-game-card__meta" style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', whiteSpace: 'nowrap' }}>
                    {tp('home.playersCount', game.playerCount)}
                    {' · '}
                    <span style={{ color: game.status === 'started' ? '#4ade80' : 'var(--accent)' }}>
                      {game.status === 'started' ? t('home.inProgress') : t('home.lobby')}
                    </span>
                  </div>
                  <div className="home-game-card__actions" style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn-primary"
                      onClick={() => handleJoin(game)}
                      disabled={!user}
                      title={!user ? t('home.loginToJoin') : undefined}
                    >
                      {isMine ? t('home.open') : t('home.join')}
                    </button>
                    {user && isMine && (
                      <button
                        onClick={() => handleDelete(game)}
                        className="btn-danger"
                        style={{ padding: '0.5rem 1rem' }}
                      >
                        {t('home.delete')}
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
        <div className="mobile-dialog-overlay" style={{
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
            className="glass-panel mobile-dialog"
            style={{ padding: '2rem', minWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}
            onClick={e => e.stopPropagation()}
            onSubmit={handlePasswordSubmit}
          >
            <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>
              {t('home.passwordFor', { name: passwordPromptGame.packName })}
            </h3>
            <input
              type="password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              placeholder={t('home.passwordPlaceholder')}
              autoFocus
            />
            {passwordError && (
              <div style={{ color: '#ef4444', fontSize: '0.875rem', textAlign: 'center' }}>{t(passwordError)}</div>
            )}
            <div className="mobile-action-row" style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="submit" className="btn-primary" style={{ flex: 1 }}>{t('home.join')}</button>
              <button
                type="button"
                onClick={() => setPasswordPromptGame(null)}
                className="btn-ghost"
                style={{ flex: 1, padding: '0.5rem 1rem' }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default HomePage;
