import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Settings from './Settings';
import { indexedDBService } from '../services/indexedDB';
import { checkCacheVersion } from '../services/cacheVersion';
import wsManager from '../utils/websocket';
import { useGame } from '../contexts/GameContext';
import config from '../config';

const GameBoard = ({ isAdmin = false }) => {
  const navigate = useNavigate();
  const { gameId } = useGame();
  const [pack, setPack] = useState(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [selectedQuestions, setSelectedQuestions] = useState(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(() => {
    const savedRoundIndex = localStorage.getItem(`currentRoundIndex-${gameId}`);
    return savedRoundIndex ? parseInt(savedRoundIndex) : 0;
  });
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState({});
  const [downloadProgress, setDownloadProgress] = useState(null);

  useEffect(() => {
    const savedQuestions = localStorage.getItem(`selectedQuestions-${gameId}`);
    if (savedQuestions) {
      const parsedQuestions = JSON.parse(savedQuestions);
      setSelectedQuestions(new Set(parsedQuestions));
    }
  }, [gameId]);

  useEffect(() => {
    if (selectedQuestions.size > 0) {
      localStorage.setItem(`selectedQuestions-${gameId}`, JSON.stringify([...selectedQuestions]));
    }
  }, [selectedQuestions, gameId]);

  const loadPack = async () => {
    try {
      setLoading(true);
      setDownloadProgress(null);
      // If the server rotated the cache key (new pack uploaded / cache
      // cleared), the cached pack and answered questions were just wiped -
      // drop them from state too so we fall through to a fresh fetch
      const cacheChanged = await checkCacheVersion(gameId);
      if (cacheChanged) {
        setSelectedQuestions(new Set());
        localStorage.removeItem(`selectedQuestions-${gameId}`);
      }
      const cachedPack = await indexedDBService.getPack(`pack-${gameId}`);

      if (cachedPack) {
        setPack(cachedPack);
        setLoading(false);
        return;
      }

      const response = await fetch(`${config.apiUrl}/api/games/${gameId}/pack`);
      if (!response.body || !window.ReadableStream) {
        const data = await response.json();
        await indexedDBService.savePack({ id: `pack-${gameId}`, ...data });
        setPack(data);
        setLoading(false);
        return;
      }
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : null;
      let loaded = 0;
      let chunks = [];
      const reader = response.body.getReader();
      let progress = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) {
          progress = Math.round((loaded / total) * 100);
          setDownloadProgress(progress);
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
      await indexedDBService.savePack({ id: `pack-${gameId}`, ...data });
      setPack(data);
    } catch (error) {
      console.error('Error loading pack:', error);
    } finally {
      setLoading(false);
      setDownloadProgress(null);
    }
  };

  useEffect(() => {
    loadPack();
    wsManager.sendRequestSelectedQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div style={{
          width: 48,
          height: 48,
          border: '4px solid var(--glass-border)',
          borderTopColor: 'var(--primary)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          marginBottom: '1rem'
        }} />
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.25rem' }}>
          {downloadProgress !== null ? `Downloading Pack... ${downloadProgress > -1 ? downloadProgress + '%' : ''}` : 'Loading...'}
        </div>
      </div>
    );
  }
  if (!pack) return <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>Error loading pack</div>;

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
          <span>⚙️</span> Settings
        </button>

        <div style={{ textAlign: 'center' }}>
          <h1 className="text-gradient" style={{
            fontSize: '3.5rem',
            fontWeight: '800',
            letterSpacing: '-0.02em',
            margin: 0,
            lineHeight: 1
          }}>
            SignAil
          </h1>
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
          fontWeight: '600',
          textShadow: '0 0 20px rgba(99, 102, 241, 0.3)'
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
            background: 'rgba(15, 23, 42, 0.6)',
            color: 'var(--text-primary)',
            fontWeight: '600',
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
            const isSelected = question.id === selectedQuestionId;
            const isAnswered = selectedQuestions.has(question.id);
            const isDisabled = (selectedQuestionId && question.id !== selectedQuestionId) || isAnswered;

            return (
              <div
                key={`q-${rowIdx}-${colIdx}`}
                style={{
                  background: isAnswered
                    ? 'rgba(15, 23, 42, 0.4)'
                    : 'linear-gradient(135deg, var(--primary), var(--secondary))',
                  color: isAnswered ? 'var(--text-muted)' : '#fff',
                  fontWeight: '700',
                  fontSize: '2rem',
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: isDisabled ? 'default' : 'pointer',
                  opacity: isDisabled ? (isAnswered ? 0.5 : 0.3) : 1,
                  transform: isHovered && !isDisabled ? 'translateY(-4px)' : 'none',
                  boxShadow: isHovered && !isDisabled ? '0 10px 25px -5px var(--primary-glow)' : 'none',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  position: 'relative',
                  overflow: 'hidden'
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
                {/* Shine effect */}
                {!isDisabled && isHovered && (
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    background: 'linear-gradient(45deg, transparent 40%, rgba(255,255,255,0.2) 50%, transparent 60%)',
                    transform: 'translateX(-100%)',
                    animation: 'shine 0.8s'
                  }} />
                )}
                <style>{`@keyframes shine { 100% { transform: translateX(100%); } }`}</style>
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
