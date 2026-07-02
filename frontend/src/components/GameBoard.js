import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Settings from './Settings';
import Logo from './Logo';
import wsManager from '../utils/websocket';
import { useGame } from '../contexts/GameContext';
import { useTranslation } from '../i18n/LanguageContext';
import { normalizeQuestion, hasUserSelection } from '../utils/questionModel';

const GameBoard = ({ isAdmin = false }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { gameId, pack, packLoading, downloadProgress } = useGame();
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [selectedQuestions, setSelectedQuestions] = useState(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(() => {
    const savedRoundIndex = localStorage.getItem(`currentRoundIndex-${gameId}`);
    return savedRoundIndex ? parseInt(savedRoundIndex) : 0;
  });

  useEffect(() => {
    const savedQuestions = localStorage.getItem(`selectedQuestions-${gameId}`);
    if (savedQuestions) {
      const parsedQuestions = JSON.parse(savedQuestions);
      setSelectedQuestions(new Set(parsedQuestions));
    } else {
      setSelectedQuestions(new Set());
    }
  }, [gameId, pack]);

  useEffect(() => {
    if (selectedQuestions.size > 0) {
      localStorage.setItem(`selectedQuestions-${gameId}`, JSON.stringify([...selectedQuestions]));
    }
  }, [selectedQuestions, gameId]);

  useEffect(() => {
    wsManager.sendRequestSelectedQuestions();
  }, [gameId]);

  useEffect(() => {
    const findQuestionById = (questionId) => {
      for (const round of pack?.rounds || []) {
        for (const theme of round.themes) {
          const q = theme.questions.find(q => q.id === questionId);
          if (q) return q;
        }
      }
      return null;
    };

    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'selected_questions_update') {
        setSelectedQuestions(new Set(data.data));
      } else if (data.type === 'question_select') {
        const { questionId } = data.data;
        setSelectedQuestionId(questionId);
        if (isAdmin) {
          navigate(`/game/${gameId}/question/${questionId}`);
        } else {
          // User-selection questions (cat-in-the-bag, karaoke, crocodile,
          // secret choice/find-a-cat): everyone joins the selection screen right
          // away, without waiting for the admin to reveal the question
          const q = findQuestionById(questionId);
          if (q && hasUserSelection(normalizeQuestion(q))) {
            navigate(`/game/${gameId}/question/${questionId}`);
          }
        }
      } else if (data.type === 'question_reveal') {
        const { questionId } = data.data;
        navigate(`/game/${gameId}/question/${questionId}`);
      } else if (data.type === 'round_change') {
        const { roundIndex } = data.data;
        setCurrentRoundIndex(roundIndex);
        localStorage.setItem(`currentRoundIndex-${gameId}`, roundIndex.toString());
      }
    });

    return () => {
      unsubscribe();
    };
  }, [navigate, isAdmin, pack, gameId]);

  const handleQuestionClick = (question) => {
    const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

    if (!isAdmin) {
      const greenFramedUsers = JSON.parse(localStorage.getItem(`greenFramedUsers-${gameId}`) || '[]');

      if (!greenFramedUsers.includes(currentUser.id)) {
        console.log('Only users with green frame can select questions');
        return;
      }
    }

    if (selectedQuestionId || selectedQuestions.has(question.id)) {
      return;
    }

    setSelectedQuestionId(question.id);
    wsManager.sendQuestionSelect(question.id, isAdmin ? 'admin' : 'user', isAdmin ? null : (currentUser.id || null));

    if (isAdmin) {
      navigate(`/game/${gameId}/question/${question.id}`);
    }
  };

  // Host-only: right-click toggles whether a question is closed (marked used)
  // or open (available again). The server owns the set and broadcasts it back,
  // so local state updates when selected_questions_update arrives.
  const handleQuestionToggle = (question) => {
    wsManager.sendQuestionToggle(question.id);
  };

  const goToNextRound = () => {
    if (currentRoundIndex < pack.rounds.length - 1) {
      const newIndex = currentRoundIndex + 1;
      setCurrentRoundIndex(newIndex);
      localStorage.setItem(`currentRoundIndex-${gameId}`, newIndex.toString());
      if (isAdmin) {
        wsManager.sendRoundChange(newIndex);
      }
    }
  };

  const goToPreviousRound = () => {
    if (currentRoundIndex > 0) {
      const newIndex = currentRoundIndex - 1;
      setCurrentRoundIndex(newIndex);
      localStorage.setItem(`currentRoundIndex-${gameId}`, newIndex.toString());
      if (isAdmin) {
        wsManager.sendRoundChange(newIndex);
      }
    }
  };

  const handleSettingsClose = () => {
    setSettingsOpen(false);
  };

  if (packLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div style={{
          width: 48,
          height: 48,
          border: '4px solid var(--glass-border)',
          borderTopColor: 'var(--primary)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          marginBottom: '1.5rem'
        }} />
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.75rem',
          width: '100%',
          maxWidth: '320px'
        }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.25rem', textAlign: 'center' }}>
            {downloadProgress !== null
              ? t('board.downloadingPack', { progress: downloadProgress > -1 ? downloadProgress + '%' : '' })
              : t('common.loading')}
          </div>
          {downloadProgress !== null && (
            <div style={{
              width: '100%',
              height: '8px',
              background: 'var(--track)',
              borderRadius: '999px',
              overflow: 'hidden',
              border: '1px solid var(--glass-border)'
            }}>
              <div
                style={{
                  width: `${downloadProgress > -1 ? downloadProgress : 0}%`,
                  height: '100%',
                  background: 'var(--fill-hover)',
                  transition: 'width 0.3s ease'
                }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }
  if (!pack) return <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>{t('board.errorLoadingPack')}</div>;

  const round = pack.rounds[currentRoundIndex];
  const themes = round.themes;
  const maxQuestions = Math.max(...themes.map(theme => theme.questions.length));

  return (
    <div className="fade-in" style={{ width: '100%', padding: '0 1rem' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '2rem 0',
        position: 'relative',
      }}>
        <button
          onClick={() => setSettingsOpen(true)}
          className="glass-panel"
          style={{
            padding: '0.75rem 1.25rem',
            color: 'var(--text-secondary)',
            border: '1px solid var(--glass-border)',
            cursor: 'pointer',
            fontSize: '1rem',
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            transition: 'var(--transition-fast)'
          }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
        >
          <span>⚙️</span> {t('common.settings')}
        </button>

        <div style={{ textAlign: 'center' }}>
          <Logo />
        </div>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: '2rem',
        gap: '2rem'
      }}>
        {isAdmin && (
          <button
            className="round-nav"
            onClick={currentRoundIndex === 0 ? undefined : goToPreviousRound}
            disabled={currentRoundIndex === 0}
          >
            ←
          </button>
        )}

        <h2 className="round-title">
          {round.name}
        </h2>

        {isAdmin && (
          <button
            className="round-nav"
            onClick={currentRoundIndex >= pack.rounds.length - 1 ? undefined : goToNextRound}
            disabled={currentRoundIndex >= pack.rounds.length - 1}
          >
            →
          </button>
        )}
      </div>

      <div className="glass-panel" style={{
        display: 'grid',
        gridTemplateColumns: `240px repeat(${maxQuestions}, 1fr)`,
        gap: '12px',
        padding: '1.5rem',
        margin: '0 auto',
        maxWidth: '1400px',
        overflowX: 'auto'
      }}>
        {themes.map((theme, rowIdx) => {
          // Ordered theme: only the leftmost still-open question is playable.
          // The host can right-click-close a tile to skip it, unlocking the next.
          const nextOrderedId = theme.ordered
            ? (theme.questions.find(q => q && q.type !== 'empty' && !selectedQuestions.has(q.id))?.id ?? null)
            : null;

          return [
          <div key={`theme-${rowIdx}`} className="board-theme" title={theme.ordered ? t('board.orderedTheme') : undefined}>
            {theme.name}
            {theme.ordered && (
              <span aria-hidden="true" style={{ marginLeft: '0.4em', opacity: 0.6 }}>⇢</span>
            )}
          </div>,
          ...Array.from({ length: maxQuestions }).map((_, colIdx) => {
            const question = theme.questions[colIdx];
            if (!question || question.type === 'empty') {
              return <div key={`empty-${rowIdx}-${colIdx}`} />;
            }

            const isAnswered = selectedQuestions.has(question.id);
            const isOrderLocked = theme.ordered && !isAnswered && question.id !== nextOrderedId;
            const isLocked = !isAnswered && ((selectedQuestionId && question.id !== selectedQuestionId) || isOrderLocked);
            const isDisabled = isLocked || isAnswered;
            // The tile being played right now: the server marks it answered
            // immediately on selection, so without this it would gray out and
            // become indistinguishable from every other closed tile
            const isCurrent = question.id === selectedQuestionId;
            // Row color variant (used by the Party Mix theme); answered tiles
            // drop it so the dimmed state always wins
            const rowVariant = ` board-cell--r${rowIdx % 6}`;
            const cellClass = isCurrent
              ? `board-cell board-cell--current${rowVariant}`
              : isAnswered
                ? 'board-cell board-cell--answered'
                : `board-cell${rowVariant}${isLocked ? ' board-cell--locked' : ''}`;

            return (
              <div
                key={`q-${rowIdx}-${colIdx}`}
                className={cellClass}
                style={{
                  // Staggered pop-in, wave running diagonally across the board
                  animationDelay: `${Math.min((rowIdx + colIdx) * 45, 600)}ms`
                }}
                onClick={() => {
                  if (!isDisabled) {
                    handleQuestionClick(question);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Toggle open/closed on right-click; the current tile keeps
                  // its own "being played" state and is left alone
                  if (isAdmin && !isCurrent) {
                    handleQuestionToggle(question);
                  }
                }}
              >
                {question.price?.text || ''}
              </div>
            );
          })
        ];
        })}
      </div>
      {settingsOpen && <Settings onClose={handleSettingsClose} isAdmin={isAdmin} />}
    </div>
  );
};

export default GameBoard;
