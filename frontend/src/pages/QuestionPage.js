import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { indexedDBService } from '../services/indexedDB';
import wsManager from '../utils/websocket';
import OnlineUsers from '../components/OnlineUsers';
import Settings from '../components/Settings';
import config from '../config';

// Sanitize HTML content to allow only safe tags and attributes
const sanitizeHtml = (html) => {
  const allowedTags = ['img', 'video', 'audio', 'source', 'p', 'br', 'strong', 'em', 'u', 'i', 'b'];
  const allowedAttributes = {
    img: ['src', 'alt', 'width', 'height', 'style'],
    video: ['src', 'controls', 'autoplay', 'loop', 'muted', 'width', 'height', 'style'],
    audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'style'],
    source: ['src', 'type'],
    '*': ['style', 'class']
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  const sanitizeNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      
      if (!allowedTags.includes(tagName)) {
        return node.textContent;
      }
      
      const allowedAttrs = allowedAttributes[tagName] || allowedAttributes['*'] || [];
      const sanitizedAttrs = {};
      
      for (const attr of allowedAttrs) {
        if (node.hasAttribute(attr)) {
          sanitizedAttrs[attr] = node.getAttribute(attr);
        }
      }
      
      const sanitizedNode = document.createElement(tagName);
      for (const [attr, value] of Object.entries(sanitizedAttrs)) {
        sanitizedNode.setAttribute(attr, value);
      }
      
      for (const child of node.childNodes) {
        const sanitizedChild = sanitizeNode(child);
        if (typeof sanitizedChild === 'string') {
          sanitizedNode.appendChild(document.createTextNode(sanitizedChild));
        } else {
          sanitizedNode.appendChild(sanitizedChild);
        }
      }
      
      return sanitizedNode;
    }
    
    return '';
  };

  const sanitized = sanitizeNode(doc.body);
  return sanitized.innerHTML;
};

const QuestionPage = ({ isAdmin = false, isReadOnly = false, onlineUsers = [] }) => {
  const { questionId } = useParams();
  const navigate = useNavigate();
  const [question, setQuestion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isQuestionRevealed, setIsQuestionRevealed] = useState(false);
  const [isAnswerRevealed, setIsAnswerRevealed] = useState(false);
  const [isResponseRevealed, setIsResponseRevealed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentRuleIndex, setCurrentRuleIndex] = useState(0);
  const [showAfterRound, setShowAfterRound] = useState(false);
  const [currentAfterRoundIndex, setCurrentAfterRoundIndex] = useState(0);
  const [currentRoundIndex, setCurrentRoundIndex] = useState(() => {
    const savedRoundIndex = localStorage.getItem('currentRoundIndex');
    return savedRoundIndex ? parseInt(savedRoundIndex) : 0;
  });
  const [timer, setTimer] = useState(15);
  const [startTime, setStartTime] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [hasRecordedTime, setHasRecordedTime] = useState(false);
  const [userTimes, setUserTimes] = useState({});

  useEffect(() => {
    const loadQuestion = async () => {
      try {
        setLoading(true);
        const pack = await indexedDBService.getPack('current');
        if (!pack) {
          throw new Error('Pack not found');
        }
        let foundQuestion = null;
        let foundRoundIndex = 0;
        
        // Search through rounds to find the question and its round index
        for (let roundIndex = 0; roundIndex < pack.rounds.length; roundIndex++) {
          const round = pack.rounds[roundIndex];
          for (const theme of round.themes) {
            const q = theme.questions.find(q => q.id === parseInt(questionId));
            if (q) {
              foundQuestion = q;
              foundRoundIndex = roundIndex;
              break;
            }
          }
          if (foundQuestion) break;
        }
        
        if (!foundQuestion) {
          throw new Error('Question not found');
        }
        
        setQuestion(foundQuestion);
        setCurrentRoundIndex(foundRoundIndex);
        localStorage.setItem('currentRoundIndex', foundRoundIndex.toString());

        // Fetch existing times for this question
        try {
          const response = await fetch(`${config.apiUrl}/api/questions/${questionId}/times`);
          const result = await response.json();
          if (result.status === 'success') {
            setUserTimes(result.data);
          }
        } catch (error) {
          console.error('Error fetching question times:', error);
        }
      } catch (error) {
        console.error('Error loading question:', error);
        navigate(isAdmin ? '/admin' : '/');
      } finally {
        setLoading(false);
      }
    };
    loadQuestion();
  }, [questionId, navigate, isAdmin]);

  useEffect(() => {
    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'question_reveal' && data.data.questionId === parseInt(questionId)) {
        setIsQuestionRevealed(true);
      } else if (data.type === 'answer_reveal' && data.data.questionId === parseInt(questionId)) {
        setIsAnswerRevealed(true);
        setShowAfterRound(true);
        setCurrentAfterRoundIndex(0);
      } else if (data.type === 'response_reveal' && data.data.questionId === parseInt(questionId)) {
        setIsResponseRevealed(true);
        setShowAfterRound(true);
      } else if (data.type === 'return_to_game') {
        navigate(isAdmin ? '/admin' : '/');
      } else if (data.type === 'elapsed_time') {
        setUserTimes(prev => ({
          ...prev,
          [data.data.userId]: data.data.elapsedTime
        }));
      } else if (data.type === 'clear_question_times') {
        setUserTimes({});
        setElapsedTime(null);
        setHasRecordedTime(false);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [questionId, navigate, isAdmin]);

  useEffect(() => {
    if (!question) return;

    if (showAfterRound) {
      const afterRoundRules = question.after_round || [];
      if (currentAfterRoundIndex >= afterRoundRules.length) {
        return;
      }

      const currentRule = afterRoundRules[currentAfterRoundIndex];
      const duration = currentRule.duration || 15;
      const timer = setTimeout(() => {
        setCurrentAfterRoundIndex(prev => prev + 1);
      }, duration * 1000);

      return () => clearTimeout(timer);
    } else {
      const rules = question.rules || [];
      if (currentRuleIndex >= rules.length) {
        return;
      }

      const currentRule = rules[currentRuleIndex];
      const duration = currentRule.duration || 15;
      const timer = setTimeout(() => {
        setCurrentRuleIndex(prev => prev + 1);
      }, duration * 1000);

      return () => clearTimeout(timer);
    }
  }, [question, currentRuleIndex, currentAfterRoundIndex, showAfterRound]);

  useEffect(() => {
    // Start timer immediately for user page, or when question is revealed for admin page
    if (isReadOnly || isQuestionRevealed) {
      const interval = setInterval(() => {
        setTimer((prevTimer) => {
          if (prevTimer <= 0) {
            return 0;
          }
          return prevTimer - 1;
        });
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [isQuestionRevealed, isReadOnly]);

  // Helper to calculate total duration from question rules
  const getInitialTimerValue = (question) => {
    if (!question || !question.rules || question.rules.length === 0) return 15;
    return question.rules.reduce((sum, rule) => sum + (rule.duration || 15), 0);
  };

  // Reset timer when question page is opened or question is revealed
  useEffect(() => {
    setTimer(getInitialTimerValue(question));
  }, [questionId, isQuestionRevealed, question]);

  // Get current user from localStorage
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        const userData = JSON.parse(storedUser);
        setCurrentUserId(userData.id);
      } catch (error) {
        console.error('Error parsing stored user data:', error);
      }
    }
  }, []);

  // Add keyboard event listener for space and right arrow
  useEffect(() => {
    const handleKeyPress = (event) => {
      if ((event.code === 'Space' || event.code === 'ArrowRight') && 
          ((isAdmin && isQuestionRevealed && !isAnswerRevealed) || (!isAdmin && !isAnswerRevealed)) &&
          !hasRecordedTime && 
          !userTimes[currentUserId]) {
        const endTime = Date.now();
        const timeTaken = (endTime - startTime) / 1000; // Convert to seconds
        setElapsedTime(timeTaken);
        setHasRecordedTime(true);
        // Send elapsed time to other users
        wsManager.sendElapsedTime(parseInt(questionId), timeTaken, currentUserId);
        console.log('=== SCORE LOG ===');
        console.log(`Score: ${question?.price?.correct || 0} points`);
        console.log(`Time taken: ${timeTaken.toFixed(3)} seconds`);
        console.log('================');
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isQuestionRevealed, isAnswerRevealed, startTime, question, isAdmin, hasRecordedTime, questionId, currentUserId, userTimes]);

  // Start timer when question is revealed or when non-admin user sees the question
  useEffect(() => {
    if ((isAdmin && isQuestionRevealed && !isAnswerRevealed) || (!isAdmin && !isAnswerRevealed)) {
      console.log('Starting timer at:', new Date().toISOString());
      setStartTime(Date.now());
      setElapsedTime(null);
      setHasRecordedTime(false);
      setUserTimes({}); // Reset all user times when starting new question
    }
  }, [isQuestionRevealed, isAnswerRevealed, isAdmin]);

  const handleShowQuestion = () => {
    if (isAdmin && question) {
      wsManager.sendQuestionReveal(question.id);
      setIsQuestionRevealed(true);
      setIsAnswerRevealed(true);
      setShowAfterRound(true);
      setCurrentAfterRoundIndex(0);
    }
  };

  const handleShowAnswer = () => {
    if (isAdmin && question) {
      wsManager.sendAnswerReveal(question.id);
      setIsAnswerRevealed(true);
      setShowAfterRound(true);
      setCurrentAfterRoundIndex(0);
    }
  };

  const handleShowAfterRound = () => {
    if (isAdmin && question) {
      wsManager.sendResponseReveal(question.id);
      setIsResponseRevealed(true);
      setShowAfterRound(true);
      setCurrentAfterRoundIndex(0);
    }
  };

  const handleReturnToGame = () => {
    if (isAdmin) {
      wsManager.sendReturnToGame();
      navigate('/admin');
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: '#fff', fontSize: '1.5rem' }}>
        Loading...
      </div>
    );
  }
  if (!question) return null;

  // --- Styles matching GameBoard ---
  const pageStyle = {
    padding: 0,
    margin: 0,
    width: '100vw',
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #10153a 0%, #181f4b 100%)',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  };
  const boardGridStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '8px',
    background: 'rgba(26,35,126,0.98)',
    padding: '2vw',
    borderRadius: '2vw',
    boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
    margin: '0 auto',
    width: '100%',
    maxWidth: '1200px',
    minWidth: 'min(100vw, 320px)',
  };
  const cardStyle = {
    background: 'linear-gradient(180deg, #283593 60%, #3949ab 100%)',
    color: '#ffd600',
    fontWeight: 'bold',
    fontSize: '1.3rem',
    textAlign: 'center',
    borderRadius: '10px',
    margin: '0',
    padding: '24px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    border: '2px solid #fffde7',
    userSelect: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '200px',
    '& img, & video, & audio': {
      maxWidth: '100%',
      maxHeight: '400px',
      margin: '10px 0',
      borderRadius: '8px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
    },
    '& video, & audio': {
      width: '100%',
      maxWidth: '600px'
    }
  };

  const buttonStyle = {
    padding: '0.75rem 1.5rem',
    background: '#28a745',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: 'bold'
  };

  const renderRule = (rule) => {
    if (rule.type === 'embedded') {
      return (
        <div
          style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
          dangerouslySetInnerHTML={{ __html: rule.content }}
        />
      );
    } else if (rule.type === 'app') {
      return (
        <div style={{ color: '#e0e0e0', fontSize: '1.1rem' }}>
          Loading app content from: {rule.path}
        </div>
      );
    }
    return null;
  };

  const renderContent = () => {
    if (showAfterRound) {
      const afterRoundRules = question.after_round || [];
      if (afterRoundRules.length > 0) {
        const lastRuleIndex = Math.min(currentAfterRoundIndex, afterRoundRules.length - 1);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {isAdmin && isQuestionRevealed && (
              <div style={cardStyle}>
                <div style={{ color: '#ffd600', fontSize: '1.5rem', marginBottom: '16px' }}>Question:</div>
                {question.rules.map((rule, index) => (
                  <div 
                    key={index} 
                    style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap', marginBottom: '8px' }}
                    dangerouslySetInnerHTML={{ __html: rule.content }}
                  />
                ))}
              </div>
            )}
            <div style={cardStyle}>
              {afterRoundRules[lastRuleIndex].type === 'embedded' ? (
                <div
                  style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
                  dangerouslySetInnerHTML={{ __html: afterRoundRules[lastRuleIndex].content }}
                />
              ) : (
                renderRule(afterRoundRules[lastRuleIndex])
              )}
            </div>
          </div>
        );
      }
    }

    const rules = question.rules || [];
    if (rules.length > 0) {
      const lastRuleIndex = Math.min(currentRuleIndex, rules.length - 1);
      return (
        <div style={cardStyle}>
          {rules[lastRuleIndex].type === 'embedded' ? (
            <div
              style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
              dangerouslySetInnerHTML={{ __html: rules[lastRuleIndex].content }}
            />
          ) : (
            renderRule(rules[lastRuleIndex])
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div style={pageStyle}>
      {/* Header: Settings button and SignAil */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: '32px',
        marginBottom: '32px',
        position: 'relative',
        width: '100%',
        maxWidth: 1200,
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
      {/* Timer centered above the question block */}
      <div style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}>
        <div style={{
          fontSize: '4rem',
          color: 'white',
          fontWeight: 'bold',
          textShadow: '0 4px 24px rgba(0,0,0,0.3)',
          marginBottom: '8px',
        }}>
          {timer}
        </div>
      </div>
      {/* Main board: rules grid */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 20,
        width: '100%',
        maxWidth: '1200px',
        margin: '0 auto 20px auto'
      }}>
        <div style={boardGridStyle}>
          {renderContent()}
        </div>
      </div>
      {/* Action buttons (Show Question/Show Answer/Show Response/Back to Game) */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: 24 }}>
        {isAdmin && !isQuestionRevealed && (
          <button
            onClick={handleShowQuestion}
            style={buttonStyle}
          >
            Show Question
          </button>
        )}
        {isAdmin && isQuestionRevealed && !isAnswerRevealed && (
          <button
            onClick={handleShowAnswer}
            style={buttonStyle}
          >
            Show Answer
          </button>
        )}
        {isAdmin && isAnswerRevealed && !isResponseRevealed && question.after_round && question.after_round.length > 0 && (
          <button
            onClick={handleShowAfterRound}
            style={buttonStyle}
          >
            Show Response
          </button>
        )}
        {isAdmin && (
          <button
            onClick={handleReturnToGame}
            style={{
              ...buttonStyle,
              background: '#dc3545'
            }}
          >
            Back to Game
          </button>
        )}
      </div>
      {/* Online users below the board */}
      <div style={{ width: '100%', maxWidth: 1200, margin: 0, padding: 0, lineHeight: 1 }}>
        <OnlineUsers 
          users={onlineUsers} 
          elapsedTime={elapsedTime}
          currentUserId={currentUserId}
          userTimes={userTimes}
          isAdmin={isAdmin}
          question={question}
        />
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} isAdmin={isAdmin} />}
    </div>
  );
};

export default QuestionPage; 