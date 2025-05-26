import React, { useEffect, useState } from 'react';
import QuestionModal from './QuestionModal';
import Settings from './Settings';
import { indexedDBService } from '../services/indexedDB';
import { Pack, Round, Theme, Question } from '../types/pack';

const GameBoard: React.FC = () => {
  const [pack, setPack] = useState<Pack | null>(null);
  const [selectedQuestion, setSelectedQuestion] = useState<Question | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [currentRoundIndex, setCurrentRoundIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [hovered, setHovered] = useState<Record<string, boolean>>({});

  const loadPack = async () => {
    try {
      setLoading(true);
      // Try to get the pack from IndexedDB first
      const cachedPack = await indexedDBService.getPack('current');
      
      if (cachedPack) {
        setPack(cachedPack);
        setLoading(false);
        return;
      }

      // If not in IndexedDB, fetch from API
      const response = await fetch('http://localhost:3000/api/pack');
      const data = await response.json();
      
      // Save to IndexedDB
      await indexedDBService.savePack({ id: 'current', ...data });
      
      setPack(data);
    } catch (error) {
      console.error('Error loading pack:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPack();
  }, []);

  if (loading) return <div>Loading...</div>;
  if (!pack) return <div>Error loading pack</div>;

  const round = pack.rounds[currentRoundIndex];
  const themes = round.themes;
  const maxQuestions = Math.max(...themes.map(theme => theme.questions.length));

  const handleQuestionClick = (question) => {
    setSelectedQuestion(question);
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setSelectedQuestion(null);
  };

  const goToNextRound = () => {
    if (currentRoundIndex < pack.rounds.length - 1) {
      setCurrentRoundIndex(currentRoundIndex + 1);
    }
  };

  const goToPreviousRound = () => {
    if (currentRoundIndex > 0) {
      setCurrentRoundIndex(currentRoundIndex - 1);
    }
  };

  const handleSettingsClose = () => {
    setSettingsOpen(false);
    // Reload pack after settings are closed in case cache was cleared
    loadPack();
  };

  const buttonStyle = {
    padding: '8px 16px',
    background: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '16px',
    minWidth: '40px'
  };

  const disabledButtonStyle = {
    ...buttonStyle,
    background: '#6c757d',
    cursor: 'not-allowed',
    opacity: 0.6
  };

  // --- Modern Board Styles for left-side themes ---
  const pageStyle = {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #0d133d 0%, #1a237e 100%)',
    padding: 0,
    margin: 0,
    width: '100vw',
    boxSizing: 'border-box',
  };
  const boardGridStyle = {
    display: 'grid',
    gridTemplateColumns: `220px repeat(${maxQuestions}, 1fr)`,
    gap: '8px',
    background: 'rgba(26,35,126,0.98)',
    padding: '2vw',
    borderRadius: '2vw',
    boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
    margin: '0 auto',
    width: '100%',
    maxWidth: '1200px',
    minWidth: 'min(100vw, 320px)',
    minHeight: '60vh',
  };
  const themeCellStyle = {
    background: 'rgba(0,0,0,0.7)',
    color: '#fffde7',
    fontWeight: 'bold',
    fontSize: '1.1rem',
    textAlign: 'center',
    padding: '16px 12px',
    borderRadius: '10px',
    minHeight: '60px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  };
  const headerCellStyle = {
    background: 'rgba(0,0,0,0.85)',
    color: '#ffd600',
    fontWeight: 'bold',
    fontSize: '1.2rem',
    textAlign: 'center',
    padding: '16px 0',
    borderRadius: '10px',
    minHeight: '60px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
  };
  const cardStyle = {
    background: 'linear-gradient(180deg, #283593 60%, #3949ab 100%)',
    color: '#ffd600',
    fontWeight: 'bold',
    fontSize: '1.8rem',
    textAlign: 'center',
    borderRadius: '10px',
    margin: '0',
    padding: '24px 0',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    cursor: 'pointer',
    transition: 'transform 0.1s, box-shadow 0.1s',
    border: '2px solid #fffde7',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const cardHoverStyle = {
    transform: 'scale(1.05)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)'
  };
  const emptyCardStyle = {
    background: 'transparent',
    border: 'none',
    boxShadow: 'none',
    cursor: 'default',
    minHeight: '64px',
  };

  // --- End Modern Board Styles ---

  return (
    <div style={pageStyle}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: '32px',
        marginBottom: '32px',
        position: 'relative',
      }}>
        <button
          onClick={() => setSettingsOpen(true)}
          style={{
            padding: '8px 16px',
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: '1.2rem',
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
        >
          ⚙️ Settings
        </button>
        <div style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <span style={{
            color: 'white',
            fontSize: '3rem',
            fontWeight: 'bold',
            letterSpacing: '0.1em',
            textShadow: '0 4px 24px rgba(0,0,0,0.3)'
          }}>
            SignAil
          </span>
        </div>
      </div>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        marginBottom: 20,
        width: '100%',
        maxWidth: '1200px',
        margin: '0 auto 20px auto'
      }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '24px',
          width: '100%',
          justifyContent: 'center'
        }}>
          <span
            onClick={currentRoundIndex === 0 ? undefined : goToPreviousRound}
            style={{
              color: currentRoundIndex === 0 ? '#6c757d' : '#007bff',
              fontSize: '2.5rem',
              cursor: currentRoundIndex === 0 ? 'default' : 'pointer',
              userSelect: 'none',
              opacity: currentRoundIndex === 0 ? 0.6 : 1
            }}
          >
            &lt;
          </span>
          <h2 style={{ 
            margin: 0, 
            color: 'white', 
            textAlign: 'center', 
            minWidth: 200,
            fontSize: '2.2rem',
            fontWeight: 'bold',
            textShadow: '0 2px 8px rgba(0,0,0,0.3)'
          }}>
            {round.name}
          </h2>
          <span
            onClick={currentRoundIndex >= pack.rounds.length - 1 ? undefined : goToNextRound}
            style={{
              color: currentRoundIndex >= pack.rounds.length - 1 ? '#6c757d' : '#007bff',
              fontSize: '2.5rem',
              cursor: currentRoundIndex >= pack.rounds.length - 1 ? 'default' : 'pointer',
              userSelect: 'none',
              opacity: currentRoundIndex >= pack.rounds.length - 1 ? 0.6 : 1
            }}
          >
            &gt;
          </span>
        </div>
      </div>
      {/* Modern Game Board Grid with themes on the left */}
      <div style={boardGridStyle}>
        {/* Theme rows */}
        {themes.map((theme, rowIdx) => [
          <div key={`theme-${rowIdx}`} style={themeCellStyle}>{theme.name}</div>,
          ...Array.from({ length: maxQuestions }).map((_, colIdx) => {
            const question = theme.questions[colIdx];
            if (!question) {
              return <div key={`empty-${rowIdx}-${colIdx}`} style={emptyCardStyle}></div>;
            }
            const isHovered = hovered[`${rowIdx}-${colIdx}`];
            return (
              <div
                key={`q-${rowIdx}-${colIdx}`}
                style={isHovered ? { ...cardStyle, ...cardHoverStyle } : cardStyle}
                onClick={() => handleQuestionClick(question)}
                onMouseEnter={() => setHovered(h => ({ ...h, [`${rowIdx}-${colIdx}`]: true }))}
                onMouseLeave={() => setHovered(h => ({ ...h, [`${rowIdx}-${colIdx}`]: false }))}
              >
                {question.price}
              </div>
            );
          })
        ])}
      </div>
      <QuestionModal open={modalOpen} question={selectedQuestion} onClose={handleCloseModal} />
      {settingsOpen && <Settings onClose={handleSettingsClose} />}
    </div>
  );
};

export default GameBoard; 