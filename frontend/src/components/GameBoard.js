import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Settings from './Settings';
import Logo from './Logo';
import wsManager from '../utils/websocket';
import { useGame } from '../contexts/GameContext';
import { useTranslation } from '../i18n/LanguageContext';

const GameBoard = ({ isAdmin = false }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { gameId, pack, packLoading, downloadProgress, loadPack } = useGame();
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [selectedQuestions, setSelectedQuestions] = useState(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(() => {
    const savedRoundIndex = localStorage.getItem(`currentRoundIndex-${gameId}`);
    return savedRoundIndex ? parseInt(savedRoundIndex) : 0;
  });
  const [hovered, setHovered] = useState({});

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
          // Cat-in-the-bag: everyone joins the selection screen right away,
          // without waiting for the admin to reveal the question
          const q = findQuestionById(questionId);
          if (q && q.type === 'secret') {
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
    loadPack();
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
              background: 'rgba(255, 255, 255, 0.1)',
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
            onClick={currentRoundIndex === 0 ? undefined : goToPreviousRound}
            disabled={currentRoundIndex === 0}
            style={{
              background: 'none',
              border: 'none',
              color: currentRoundIndex === 0 ? 'var(--text-muted)' : 'var(--primary)',
              fontSize: '2rem',
              cursor: currentRoundIndex === 0 ? 'default' : 'pointer',
              transition: 'var(--transition-fast)',
              padding: '0.5rem'
            }}
          >
            ←
          </button>
        )}

        <h2 style={{
          margin: 0,
          color: 'var(--text-primary)',
          fontSize: '2rem',
          fontWeight: '600'
        }}>
          {round.name}
        </h2>

        {isAdmin && (
          <button
            onClick={currentRoundIndex >= pack.rounds.length - 1 ? undefined : goToNextRound}
            disabled={currentRoundIndex >= pack.rounds.length - 1}
            style={{
              background: 'none',
              border: 'none',
              color: currentRoundIndex >= pack.rounds.length - 1 ? 'var(--text-muted)' : 'var(--primary)',
              fontSize: '2rem',
              cursor: currentRoundIndex >= pack.rounds.length - 1 ? 'default' : 'pointer',
              transition: 'var(--transition-fast)',
              padding: '0.5rem'
            }}
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
        {themes.map((theme, rowIdx) => [
          <div key={`theme-${rowIdx}`} style={{
            background: 'var(--bg-dark)',
            color: 'var(--text-primary)',
            fontWeight: '500',
            fontSize: '1.1rem',
            textAlign: 'center',
            padding: '1rem',
            borderRadius: '12px',
            minHeight: '80px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--glass-border)'
          }}>
            {theme.name}
          </div>,
          ...Array.from({ length: maxQuestions }).map((_, colIdx) => {
            const question = theme.questions[colIdx];
            if (!question || question.type === 'empty') {
              return <div key={`empty-${rowIdx}-${colIdx}`} />;
            }

            const isHovered = hovered[`${rowIdx}-${colIdx}`];
            const isAnswered = selectedQuestions.has(question.id);
            const isDisabled = (selectedQuestionId && question.id !== selectedQuestionId) || isAnswered;

            return (
              <div
                key={`q-${rowIdx}-${colIdx}`}
                style={{
                  background: isAnswered
                    ? 'var(--bg-dark)'
                    : isHovered && !isDisabled ? 'var(--fill-hover)' : 'var(--fill)',
                  color: isAnswered ? 'var(--text-muted)' : '#fff',
                  fontWeight: '700',
                  fontSize: '2rem',
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: isDisabled ? 'default' : 'pointer',
                  opacity: isDisabled ? (isAnswered ? 0.5 : 0.3) : 1,
                  transition: 'background var(--transition-fast), opacity var(--transition-fast)',
                  border: '1px solid transparent'
                }}
                onClick={() => {
                  if (!isDisabled) {
                    handleQuestionClick(question);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (isAdmin && !isDisabled) {
                    handleQuestionClick(question);
                  }
                }}
                onMouseEnter={() => !isDisabled && setHovered(h => ({ ...h, [`${rowIdx}-${colIdx}`]: true }))}
                onMouseLeave={() => !isDisabled && setHovered(h => ({ ...h, [`${rowIdx}-${colIdx}`]: false }))}
              >
                {question.price?.text || ''}
              </div>
            );
          })
        ])}
      </div>
      {settingsOpen && <Settings onClose={handleSettingsClose} isAdmin={isAdmin} />}
    </div>
  );
};

export default GameBoard;
