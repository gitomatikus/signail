import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useGame } from '../contexts/GameContext';
import GamePage from './GamePage';
import config from '../config';
import { getHostToken, removeHostToken } from '../services/gameAuth';
import { useTranslation } from '../i18n/LanguageContext';

const Avatar = ({ src, alt, size = 72 }) => {
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '18px',
    objectFit: 'cover',
    border: '2px solid var(--glass-border)',
    background: 'var(--bg-dark)'
  };
  if (!src) return <div style={style} />;
  return src.toLowerCase().endsWith('.mp4')
    ? <video src={src} style={style} autoPlay loop muted playsInline />
    : <img src={src} alt={alt} style={style} onError={e => { e.target.style.visibility = 'hidden'; }} />;
};

// Waiting room shown before the host presses Start: everyone sees who has
// joined; the host can start or delete the game.
const Lobby = () => {
  const navigate = useNavigate();
  const { t, tp } = useTranslation();
  const { gameId, isHost, gameInfo, onlineUsers, startGame, packLoading, downloadProgress } = useGame();

  const handleDelete = async () => {
    if (!window.confirm(t('lobby.deleteConfirm'))) return;
    try {
      await fetch(`${config.apiUrl}/api/games/${gameId}`, {
        method: 'DELETE',
        headers: { 'X-Host-Token': getHostToken(gameId) }
      });
      removeHostToken(gameId);
      navigate('/');
    } catch (e) {
      console.error('Error deleting game:', e);
    }
  };

  return (
    <div className="fade-in" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '2rem',
      gap: '1.5rem'
    }}>
      <div className="glass-panel" style={{
        padding: '2.5rem',
        width: '100%',
        maxWidth: '700px',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        textAlign: 'center'
      }}>
        <div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('lobby.title')}
          </div>
          <h1 className="text-gradient" style={{ fontSize: '2.5rem', fontWeight: 800, margin: '0.25rem 0 0' }}>
            {gameInfo.packName}
          </h1>
          <div style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            {t('home.hostedBy')} <strong style={{ color: 'var(--text-primary)' }}>{gameInfo.hostName}</strong>
            {gameInfo.packAuthor ? <> · {t('home.packBy')} {gameInfo.packAuthor}</> : null}
          </div>
          {packLoading && (
            <div className="fade-in" style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.5rem',
              margin: '1rem auto 0',
              maxWidth: '320px',
              padding: '0.75rem',
              background: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '8px',
              border: '1px solid var(--glass-border)'
            }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: '500' }}>
                {downloadProgress !== null
                  ? t('board.downloadingPack', { progress: downloadProgress > -1 ? downloadProgress + '%' : '' })
                  : t('common.loading')}
              </div>
              <div style={{
                width: '100%',
                height: '8px',
                background: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '999px',
                overflow: 'hidden',
                border: '1px solid var(--glass-border)'
              }}>
                <div
                  style={{
                    width: `${downloadProgress > -1 ? downloadProgress : 0}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                    transition: 'width 0.3s ease',
                    boxShadow: '0 0 10px var(--primary-glow)'
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div>
          <div style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            {onlineUsers.length === 0
              ? t('lobby.noPlayers')
              : tp('lobby.playersJoined', onlineUsers.length)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', justifyContent: 'center' }}>
            {onlineUsers.map(player => (
              <div key={player.id} className="fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', width: '90px' }}>
                <Avatar src={player.imageUrl} alt={player.name} />
                <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', wordBreak: 'break-word' }}>{player.name}</span>
              </div>
            ))}
          </div>
        </div>

        {isHost ? (
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              className="btn-primary"
              style={{ padding: '0.75rem 3rem', fontSize: '1.1rem' }}
              onClick={startGame}
            >
              {t('lobby.start')}
            </button>
            <button
              onClick={handleDelete}
              style={{
                padding: '0.75rem 1.5rem',
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#ef4444',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '8px',
                cursor: 'pointer'
              }}
            >
              {t('lobby.deleteGame')}
            </button>
          </div>
        ) : (
          <div style={{ color: 'var(--accent)', fontWeight: 600 }}>
            {t('lobby.waitingForHost', { name: gameInfo.hostName })}
          </div>
        )}

        <button
          onClick={() => navigate('/')}
          style={{
            alignSelf: 'center',
            padding: '0.5rem 1.5rem',
            background: 'rgba(255, 255, 255, 0.08)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--glass-border)',
            borderRadius: '8px',
            cursor: 'pointer'
          }}
        >
          {t('lobby.leave')}
        </button>
      </div>
    </div>
  );
};

// One game room: the lobby until the host starts the game, the board after
const GameRoomPage = () => {
  const { gameInfo } = useGame();
  return gameInfo.status === 'started' ? <GamePage /> : <Lobby />;
};

export default GameRoomPage;
