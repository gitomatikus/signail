import React, { useEffect, useMemo, useState } from 'react';
import { useGame } from '../contexts/GameContext';
import { useTranslation } from '../i18n/LanguageContext';
import { HIDE_HOST_EVENT, HIDE_HOST_KEY } from '../utils/hostVisibility';

const numericScore = (player) => {
  const score = Number(player?.score ?? 0);
  return Number.isFinite(score) ? score : 0;
};

const sortByScore = (players) => [...players].sort((a, b) => {
  const scoreDifference = numericScore(b) - numericScore(a);
  if (scoreDifference !== 0) return scoreDifference;
  return String(a?.name || '').localeCompare(String(b?.name || ''));
});

const PlayerAvatar = ({ player, className = '' }) => {
  const imageUrl = player?.imageUrl || '';
  const isVideo = imageUrl.toLowerCase().endsWith('.mp4');

  return (
    <span className={`board-player-avatar ${className}`} aria-hidden="true">
      {imageUrl && (isVideo ? (
        <video src={imageUrl} autoPlay loop muted playsInline />
      ) : (
        <img src={imageUrl} alt="" />
      ))}
    </span>
  );
};

const BoardPlayerSummary = () => {
  const { onlineUsers = [], user, gameInfo } = useGame();
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [hideHost, setHideHost] = useState(() => localStorage.getItem(HIDE_HOST_KEY) === 'true');

  useEffect(() => {
    const onHostVisibilityChange = () => {
      setHideHost(localStorage.getItem(HIDE_HOST_KEY) === 'true');
    };
    window.addEventListener(HIDE_HOST_EVENT, onHostVisibilityChange);
    return () => window.removeEventListener(HIDE_HOST_EVENT, onHostVisibilityChange);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const rankedPlayers = useMemo(() => sortByScore(onlineUsers), [onlineUsers]);
  const currentPlayer = rankedPlayers.find(player => player.id === user?.id);
  const compactPlayers = [];

  if (currentPlayer) compactPlayers.push(currentPlayer);
  rankedPlayers.forEach((player) => {
    if (compactPlayers.length < (rankedPlayers.length > 3 ? 2 : 3)
      && !compactPlayers.some(item => item.id === player.id)) {
      compactPlayers.push(player);
    }
  });

  const showHostCompact = !hideHost && gameInfo && rankedPlayers.length <= 2;
  const hasExpandableRoster = rankedPlayers.length > compactPlayers.length;

  if (rankedPlayers.length === 0 && !showHostCompact) return null;

  return (
    <>
      <section className="board-player-summary glass-panel" aria-label={t('users.scoreboard')}>
        <div className="board-player-summary__cards">
          {compactPlayers.map((player) => {
            const isCurrentUser = player.id === user?.id;
            const isLeader = rankedPlayers[0]?.id === player.id;

            return (
              <button
                type="button"
                key={player.id || player.name}
                className={`board-player-chip${isCurrentUser ? ' board-player-chip--you' : ''}`}
                onClick={() => hasExpandableRoster && setIsOpen(true)}
                aria-label={`${player.name}, ${numericScore(player)}`}
              >
                <PlayerAvatar player={player} />
                <span className="board-player-chip__copy">
                  <span className="board-player-chip__name">
                    {isLeader && rankedPlayers.length > 1 && (
                      <span className="board-player-chip__leader" aria-label={t('users.leader')}>★</span>
                    )}
                    {player.name}
                  </span>
                  <span className="board-player-chip__score">{numericScore(player)}</span>
                </span>
                {isCurrentUser && <span className="board-player-badge">{t('users.you')}</span>}
              </button>
            );
          })}

          {showHostCompact && (
            <button
              type="button"
              className="board-player-chip board-player-chip--host"
              onClick={() => setIsOpen(true)}
            >
              <PlayerAvatar player={{
                imageUrl: gameInfo.hostImageUrl,
                name: gameInfo.hostName,
              }} />
              <span className="board-player-chip__copy">
                <span className="board-player-chip__name">{gameInfo.hostName}</span>
                <span className="board-player-badge board-player-badge--host">{t('users.host')}</span>
              </span>
            </button>
          )}

          {hasExpandableRoster && (
            <button
              type="button"
              className="board-player-count"
              onClick={() => setIsOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={isOpen}
            >
              <span className="board-player-count__avatars" aria-hidden="true">
                {rankedPlayers.slice(-3).map(player => (
                  <PlayerAvatar key={player.id || player.name} player={player} />
                ))}
              </span>
              <span>{t('users.playersCountShort', { count: rankedPlayers.length })}</span>
              <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
      </section>

      {isOpen && (
        <div className="board-roster-overlay" onMouseDown={() => setIsOpen(false)}>
          <section
            className="board-roster-sheet glass-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-roster-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="board-roster-sheet__handle" aria-hidden="true" />
            <header className="board-roster-sheet__header">
              <div>
                <h2 id="board-roster-title">{t('users.allPlayers')}</h2>
                <span>{t('users.playersCountShort', { count: rankedPlayers.length })}</span>
              </div>
              <button
                type="button"
                className="board-roster-sheet__close"
                onClick={() => setIsOpen(false)}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </header>

            <div className="board-roster-list">
              {rankedPlayers.map((player, index) => (
                <div
                  className={`board-roster-row${player.id === user?.id ? ' board-roster-row--you' : ''}`}
                  key={player.id || player.name}
                >
                  <span className="board-roster-row__rank">{index + 1}</span>
                  <PlayerAvatar player={player} />
                  <span className="board-roster-row__name">
                    {player.name}
                    {player.id === user?.id && (
                      <span className="board-player-badge">{t('users.you')}</span>
                    )}
                  </span>
                  <strong>{numericScore(player)}</strong>
                </div>
              ))}

              {!hideHost && gameInfo && (
                <div className="board-roster-row board-roster-row--host">
                  <span className="board-roster-row__rank">—</span>
                  <PlayerAvatar player={{
                    imageUrl: gameInfo.hostImageUrl,
                    name: gameInfo.hostName,
                  }} />
                  <span className="board-roster-row__name">{gameInfo.hostName}</span>
                  <span className="board-player-badge board-player-badge--host">{t('users.host')}</span>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
};

export default BoardPlayerSummary;
