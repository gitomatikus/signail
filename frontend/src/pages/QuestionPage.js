import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { indexedDBService } from '../services/indexedDB';
import { checkCacheVersion } from '../services/cacheVersion';
import wsManager from '../utils/websocket';
import OnlineUsers from '../components/OnlineUsers';
import ProgressiveImage from '../components/ProgressiveImage';
import ImageLightbox from '../components/ImageLightbox';
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
  const [themeName, setThemeName] = useState('');
  const [timer, setTimer] = useState(15);
  const [startTime, setStartTime] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [hasRecordedTime, setHasRecordedTime] = useState(false);
  const [userTimes, setUserTimes] = useState({});
  const [clickedIndices, setClickedIndices] = useState(new Set());
  const [secretSelectorId, setSecretSelectorId] = useState(null);
  const [secretTargetId, setSecretTargetId] = useState(null);
  const [clicksLeftMap, setClicksLeftMap] = useState({});
  const [numberAnswers, setNumberAnswers] = useState({});
  const [answersRevealed, setAnswersRevealed] = useState(false);
  const [answerInput, setAnswerInput] = useState('');
  const [selectedOptions, setSelectedOptions] = useState(new Set());
  const [textAnswerInput, setTextAnswerInput] = useState('');
  const [pastedImage, setPastedImage] = useState(null);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [redJudgedUsers, setRedJudgedUsers] = useState(new Set());
  // Grants already applied; a grant must never be applied twice even if the
  // same broadcast is somehow delivered more than once
  const processedGrantIds = useRef(new Set());

  useEffect(() => {
    const loadQuestion = async () => {
      try {
        setLoading(true);
        setThemeName('');
        setClicksLeftMap({}); // Click budgets are per-question; drop stale entries
        setNumberAnswers({});
        setAnswersRevealed(false);
        setAnswerInput('');
        setSelectedOptions(new Set());
        setTextAnswerInput('');
        setPastedImage(null);
        setRedJudgedUsers(new Set());
        // Stale cache (new pack uploaded / cache cleared): this question may
        // no longer exist, so go back to the board and load everything fresh
        const cacheChanged = await checkCacheVersion();
        if (cacheChanged) {
          navigate(isAdmin ? '/admin' : '/');
          return;
        }
        const pack = await indexedDBService.getPack('current');
        if (!pack) {
          throw new Error('Pack not found');
        }
        let foundQuestion = null;
        let foundRoundIndex = 0;
        let foundThemeName = '';

        // Search through rounds to find the question and its round index
        for (let roundIndex = 0; roundIndex < pack.rounds.length; roundIndex++) {
          const round = pack.rounds[roundIndex];
          for (const theme of round.themes) {
            const q = theme.questions.find(q => q.id === parseInt(questionId));
            if (q) {
              foundQuestion = q;
              foundRoundIndex = roundIndex;
              foundThemeName = theme.name || '';
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
        setThemeName(foundThemeName);
        localStorage.setItem('currentRoundIndex', foundRoundIndex.toString());

        // For cat-in-the-bag, restore who selected it and who answers it (survives refresh).
        // Must happen before the times fetch: assigning the target resets userTimes.
        if (foundQuestion.type === 'secret') {
          try {
            const response = await fetch(`${config.apiUrl}/api/questions/${questionId}/secret`);
            const result = await response.json();
            if (result.status === 'success') {
              setSecretSelectorId(result.data.selectorId || null);
              setSecretTargetId(result.data.assignment?.targetUserId || null);
              if (result.data.revealed) {
                setIsQuestionRevealed(true);
              }
            }
          } catch (error) {
            console.error('Error fetching secret question info:', error);
          }
        }

        // For submission-based types (close-enough numbers, choice picks, text
        // answers), restore submissions (masked until reveal; own value included)
        if (['close-enough', 'choice', 'text-answer'].includes(foundQuestion.type)) {
          try {
            const storedUser = localStorage.getItem('user');
            const myId = storedUser ? JSON.parse(storedUser).id : null;
            const query = myId ? `?userId=${encodeURIComponent(myId)}` : '';
            const response = await fetch(`${config.apiUrl}/api/questions/${questionId}/answers${query}`);
            const result = await response.json();
            if (result.status === 'success') {
              setNumberAnswers(result.data.answers || {});
              setAnswersRevealed(!!result.data.revealed);
            }
          } catch (error) {
            console.error('Error fetching question answers:', error);
          }
        }

        // For find-a-cat with a click limit, restore remaining clicks (survives refresh)
        if (foundQuestion.type === 'find-a-cat' && foundQuestion.max_clicks > 0) {
          try {
            const response = await fetch(`${config.apiUrl}/api/questions/${questionId}/clicks`);
            const result = await response.json();
            if (result.status === 'success') {
              setClicksLeftMap(result.data);
            }
          } catch (error) {
            console.error('Error fetching question clicks:', error);
          }
        }

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
      } else if (data.type === 'secret_assign' && data.data.questionId === parseInt(questionId)) {
        setSecretTargetId(data.data.targetUserId);
        if (data.data.selectorUserId) {
          setSecretSelectorId(data.data.selectorUserId);
        }
      } else if (data.type === 'cat_clicks' && data.data.questionId === parseInt(questionId)) {
        // Each client is authoritative for its own clicks; ignore the echo of our own reports
        if (data.data.userId !== currentUserId) {
          setClicksLeftMap(prev => ({ ...prev, [data.data.userId]: data.data.clicksLeft }));
        }
      } else if (data.type === 'cat_clicks_grant' && data.data.questionId === parseInt(questionId)) {
        const { grantId } = data.data;
        const alreadyApplied = grantId !== undefined && processedGrantIds.current.has(grantId);
        if (!alreadyApplied) {
          if (grantId !== undefined) {
            processedGrantIds.current.add(grantId);
          }
          setClicksLeftMap(prev => {
            // No entry yet means the player hasn't clicked: their budget is the full max_clicks
            const base = prev[data.data.userId] ?? (question && question.max_clicks > 0 ? question.max_clicks : null);
            if (base === null) {
              return prev;
            }
            return { ...prev, [data.data.userId]: base + data.data.amount };
          });
        }
      } else if (data.type === 'number_answer_submitted' && data.data.questionId === parseInt(questionId)) {
        // Mark that the player answered without exposing their number
        if (data.data.userId !== currentUserId) {
          setNumberAnswers(prev => (
            prev[data.data.userId] === undefined ? { ...prev, [data.data.userId]: true } : prev
          ));
        }
      } else if (data.type === 'number_answers' && data.data.questionId === parseInt(questionId)) {
        setNumberAnswers(prev => ({ ...prev, ...data.data.answers }));
        setAnswersRevealed(true);
      } else if (data.type === 'admin_clicked_red_number') {
        // Progressive reveal: a judged-wrong buzz no longer pauses the reveal
        setRedJudgedUsers(prev => new Set([...prev, data.data.userId]));
      } else if (data.type === 'admin_clicked_green_number') {
        // Progressive reveal: a correct answer uncovers the image completely
        if (question?.type === 'progressive-reveal') {
          setTimer(0);
        }
      } else if (data.type === 'clear_question_times') {
        setUserTimes({});
        setElapsedTime(null);
        setHasRecordedTime(false);
        setClickedIndices(new Set());
        setSecretSelectorId(null);
        setSecretTargetId(null);
        setClicksLeftMap({});
        setNumberAnswers({});
        setAnswersRevealed(false);
        setAnswerInput('');
        setSelectedOptions(new Set());
        setTextAnswerInput('');
        setPastedImage(null);
        setRedJudgedUsers(new Set());
      }
    });
    return () => {
      unsubscribe();
    };
  }, [questionId, navigate, isAdmin, question, currentUserId]);

  useEffect(() => {
    if (!question) return;
    // For cat-in-the-bag, rules don't advance until a player is chosen
    // and (for players) the admin has shown the question
    if (question.type === 'secret' && (!secretTargetId || (!isAdmin && !isQuestionRevealed))) return;

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
  }, [question, currentRuleIndex, currentAfterRoundIndex, showAfterRound, secretTargetId, isAdmin, isQuestionRevealed]);

  useEffect(() => {
    // For cat-in-the-bag, the countdown waits until a player is chosen
    // and (for players) the admin has shown the question
    if (question?.type === 'secret' && (!secretTargetId || (!isAdmin && !isQuestionRevealed))) {
      return;
    }
    // Progressive reveal: pause while any buzz awaits the admin's verdict
    if (question?.type === 'progressive-reveal'
      && Object.keys(userTimes).some(uid => !redJudgedUsers.has(uid))) {
      return;
    }
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
  }, [isQuestionRevealed, isReadOnly, question, secretTargetId, userTimes, redJudgedUsers]);

  // Helper to calculate total duration from question rules
  const getInitialTimerValue = (question) => {
    if (!question) return 15;
    if (question.type === 'find-a-cat') {
      return question.duration || 60;
    }
    if (question.type === 'close-enough' && question.duration) {
      return question.duration;
    }
    if (question.type === 'progressive-reveal') {
      return question.duration || 60;
    }
    if (!question.rules || question.rules.length === 0) return 15;
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
      if (['find-a-cat', 'close-enough', 'choice', 'text-answer'].includes(question?.type)) {
        return; // These types answer by clicking/typing, not by racing on the spacebar
      }
      if (question?.type === 'secret') {
        // Only the chosen player can answer a cat-in-the-bag question,
        // and only after the admin has shown the question
        if (!secretTargetId || (!isAdmin && (currentUserId !== secretTargetId || !isQuestionRevealed))) {
          return;
        }
      }
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
  }, [isQuestionRevealed, isAnswerRevealed, startTime, question, isAdmin, hasRecordedTime, questionId, currentUserId, userTimes, secretTargetId]);

  // Start timer when question is revealed or when non-admin user sees the question
  // For cat-in-the-bag, wait until a player is chosen and the admin shows the question
  useEffect(() => {
    if (question?.type === 'secret' && (!secretTargetId || (!isAdmin && !isQuestionRevealed))) {
      return;
    }
    if ((isAdmin && isQuestionRevealed && !isAnswerRevealed) || (!isAdmin && !isAnswerRevealed)) {
      console.log('Starting timer at:', new Date().toISOString());
      setStartTime(Date.now());
      setElapsedTime(null);
      setHasRecordedTime(false);
      setUserTimes({}); // Reset all user times when starting new question
      setClickedIndices(new Set()); // Reset clicked indices for new question!
    }
  }, [isQuestionRevealed, isAnswerRevealed, isAdmin, secretTargetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync clickedIndices when page is loaded/refreshed and user has already recorded time
  useEffect(() => {
    if (currentUserId && userTimes[currentUserId] !== undefined && question && question.type === 'find-a-cat' && question.map) {
      setHasRecordedTime(true);
      setClickedIndices(new Set(question.map.map((_, i) => i)));
    }
  }, [userTimes, currentUserId, question]);

  const handleShowQuestion = () => {
    if (isAdmin && question) {
      wsManager.sendQuestionReveal(question.id);
      setIsQuestionRevealed(true);
      if (question.type !== 'find-a-cat') {
        setIsAnswerRevealed(true);
        setShowAfterRound(true);
        setCurrentAfterRoundIndex(0);
      } else {
        setIsAnswerRevealed(false);
        setShowAfterRound(false);
      }
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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
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
        <div style={{ color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.25rem' }}>Loading...</div>
      </div>
    );
  }
  if (!question) return null;

  const pageStyle = {
    padding: 0,
    margin: 0,
    width: '100vw',
    minHeight: '100vh',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  };
  const boardGridStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '1.5rem',
    padding: '2rem',
    borderRadius: '16px',
    margin: '0 auto',
    width: '100%',
    maxWidth: '1200px',
  };
  const cardStyle = {
    color: 'var(--text-primary)',
    fontWeight: '600',
    fontSize: '1.3rem',
    textAlign: 'center',
    borderRadius: '16px',
    margin: '0',
    padding: '2rem',
    border: '1px solid var(--glass-border)',
    userSelect: 'text',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '200px',
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(10px)',
    boxShadow: 'var(--glass-shadow)',
  };
  const themeHeaderStyle = {
    color: 'var(--text-primary)',
    fontWeight: '700',
    fontSize: '1.5rem',
    textAlign: 'center',
    borderRadius: '12px',
    margin: '0',
    padding: '1rem',
    background: 'rgba(15, 23, 42, 0.6)',
    border: '1px solid var(--glass-border)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    userSelect: 'none',
    textShadow: '0 0 20px var(--primary-glow)'
  };

  const buttonStyle = {
    padding: '0.75rem 1.5rem',
    background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
    color: '#fff',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: '600',
    transition: 'all 0.2s',
    boxShadow: '0 4px 12px var(--primary-glow)'
  };

  const renderRule = (rule) => {
    if (rule.type === 'embedded') {
      return (
        <div
          className="question-content"
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



  // Find-a-cat click budget: every click (hit or miss) consumes one click
  const hasClickLimit = question?.type === 'find-a-cat' && Number(question?.max_clicks) > 0;
  const myClicksLeft = hasClickLimit ? (clicksLeftMap[currentUserId] ?? question.max_clicks) : Infinity;
  const isOutOfClicks = hasClickLimit && !isAdmin && myClicksLeft <= 0;

  const consumeClick = () => {
    if (!hasClickLimit || isAdmin || !currentUserId) {
      return;
    }
    const newLeft = Math.max(0, myClicksLeft - 1);
    setClicksLeftMap(prev => ({ ...prev, [currentUserId]: newLeft }));
    wsManager.sendCatClicks(parseInt(questionId), currentUserId, newLeft);
  };

  const handleAreaClick = (e, index) => {
    e.stopPropagation(); // Don't let the container's miss handler count this click too
    if (isAnswerRevealed || hasRecordedTime || (currentUserId && userTimes[currentUserId])) {
      return;
    }
    if (clickedIndices.has(index)) {
      return;
    }
    if (isOutOfClicks) {
      return;
    }

    const newClicked = new Set(clickedIndices);
    newClicked.add(index);
    setClickedIndices(newClicked);

    if (isAdmin) {
      // Admin doesn't submit time
      return;
    }

    consumeClick();

    const totalAreas = question.map ? question.map.length : 0;
    const remaining = totalAreas - newClicked.size;

    if (remaining === 0) {
      const endTime = Date.now();
      const timeTaken = (endTime - startTime) / 1000;
      setElapsedTime(timeTaken);
      setHasRecordedTime(true);
      wsManager.sendElapsedTime(parseInt(questionId), timeTaken, currentUserId);
      console.log('=== SCORE LOG (Find a Cat) ===');
      console.log(`Score: ${question?.price?.correct || 0} points`);
      console.log(`Time taken: ${timeTaken.toFixed(3)} seconds`);
      console.log('================');
    }
  };

  const handleMissClick = () => {
    if (!hasClickLimit || isAdmin) {
      return;
    }
    if (isAnswerRevealed || hasRecordedTime || (currentUserId && userTimes[currentUserId])) {
      return;
    }
    if (myClicksLeft <= 0) {
      return;
    }
    consumeClick();
  };

  const renderFindACatContent = () => {
    const totalAreas = question.map ? question.map.length : 0;
    const remainingCount = totalAreas - clickedIndices.size;
    const hasFailed = isOutOfClicks && remainingCount > 0;
    // `task` is full text with optional %total%/%left% placeholders;
    // legacy packs only have `name` ("котиків") and keep the old wording
    const taskTemplate = question.task
      ? question.task
      : `Знайдіть і клікніть на всіх ${question.name || ''}. Залишилось всього %left%`;
    const renderTaskText = (left) => taskTemplate
      .replace(/%total%/g, String(totalAreas))
      .replace(/%left%/g, String(left));
    const successText = question.task
      ? 'Ви знайшли всіх!'
      : `Ви знайшли всіх ${question.name || ''}!`;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '1.5rem' }}>
        {/* Helper message */}
        <div className="glass-panel" style={{
          padding: '1rem 2rem',
          fontSize: '1.4rem',
          fontWeight: '700',
          color: 'var(--text-primary)',
          textAlign: 'center',
          border: hasFailed ? '1px solid #ef4444' : '1px solid var(--glass-border)',
          width: '100%',
          maxWidth: '800px',
          boxShadow: hasFailed ? '0 0 20px rgba(239, 68, 68, 0.4)' : 'var(--glass-shadow)',
          textShadow: '0 2px 4px rgba(0,0,0,0.3)'
        }}>
          {hasFailed ? (
            <span style={{ color: '#ef4444' }}>Кліки закінчилися! Зачекайте на рішення ведучого.</span>
          ) : remainingCount > 0 ? (
            renderTaskText(remainingCount)
          ) : (
            successText
          )}
          {hasClickLimit && !isAdmin && !hasFailed && remainingCount > 0 && (
            <div style={{
              fontSize: '1.1rem',
              marginTop: '0.5rem',
              color: myClicksLeft <= 2 ? '#ef4444' : 'var(--text-secondary)'
            }}>
              🖱 Залишилось кліків: {myClicksLeft}
            </div>
          )}
        </div>

        {/* Image Container with map areas; container clicks are misses that consume the budget */}
        <div
          onClick={handleMissClick}
          style={{
            position: 'relative',
            display: 'inline-block',
            width: '100%',
            maxWidth: '800px',
            borderRadius: '16px',
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
            border: '1px solid var(--glass-border)'
          }}>
          <img 
            src={question.image} 
            alt={question.task || question.name}
            style={{ 
              width: '100%', 
              height: 'auto', 
              display: 'block', 
              userSelect: 'none',
              pointerEvents: 'none'
            }} 
          />
          {/* Overlay Map Areas */}
          {question.map && question.map.map((area, idx) => {
            const isClicked = clickedIndices.has(idx);
            const showArea = isAnswerRevealed || isClicked; // Show area if answer is revealed or if the user clicked it

            // Determine custom styles and colors from map area
            let backgroundColor = 'transparent';
            let border = 'none';
            let boxShadow = 'none';

            if (showArea) {
              const style = area.style || {};
              const customBg = style.background || style.backgroundColor || area.background || area.color;
              
              let bg = 'rgba(239, 68, 68, 0.1)';
              let borderStyle = '2px solid #ef4444';
              let shadowStyle = '0 0 12px rgba(239, 68, 68, 0.6)';

              if (customBg) {
                // Try to determine a solid base color to use for border/shadow if not overridden
                let solidColor = customBg;
                if (typeof customBg === 'string') {
                  const rgbaMatch = customBg.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
                  if (rgbaMatch) {
                    solidColor = `rgb(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]})`;
                  } else if (customBg.startsWith('#') && customBg.length === 9) {
                    solidColor = customBg.substring(0, 7);
                  }
                }

                bg = `color-mix(in srgb, ${solidColor} 10%, transparent)`;
                borderStyle = `2px solid ${solidColor}`;
                shadowStyle = `0 0 12px ${solidColor}`;
              }

              if (style.border) {
                borderStyle = style.border;
              } else if (style.borderColor) {
                borderStyle = `2px solid ${style.borderColor}`;
              } else if (area.borderColor) {
                borderStyle = `2px solid ${area.borderColor}`;
              }

              if (style.boxShadow) {
                shadowStyle = style.boxShadow;
              }

              backgroundColor = bg;
              border = borderStyle;
              boxShadow = shadowStyle;
            }

            const areaStyle = {
              position: 'absolute',
              left: area.left,
              top: area.top,
              width: area.width,
              height: area.height,
              cursor: 'default',
              backgroundColor,
              border,
              boxShadow,
              borderRadius: '8px',
              transition: 'background-color 0.2s, border 0.2s, box-shadow 0.2s',
              // Disable clicks if already clicked, answer revealed, out of clicks, or current user has recorded time (unless admin, who can click for demo, but only if not revealed yet)
              pointerEvents: isClicked || isAnswerRevealed || (!isAdmin && hasRecordedTime) || isOutOfClicks ? 'none' : 'auto'
            };

            return (
              <div
                key={idx}
                style={areaStyle}
                onClick={(e) => handleAreaClick(e, idx)}
                title={isAdmin && isAnswerRevealed ? `Area ${idx + 1}` : ''}
              />
            );
          })}
        </div>

        {/* If answer is revealed and there are after-round rules, display them below */}
        {showAfterRound && question.after_round && question.after_round.length > 0 && (
          <div style={{ ...cardStyle, width: '100%', maxWidth: '800px', minHeight: 'auto', padding: '1.5rem', marginTop: '1rem' }}>
            {question.after_round.map((rule, index) => (
              <div key={index} style={{ width: '100%' }}>
                {rule.type === 'embedded' ? (
                  <div
                    className="question-content"
                    style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
                    dangerouslySetInnerHTML={{ __html: rule.content }}
                  />
                ) : (
                  renderRule(rule)
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const handleSecretAssign = (targetUserId) => {
    if (secretTargetId) {
      return;
    }
    wsManager.sendSecretAssign(parseInt(questionId), targetUserId, secretSelectorId);
  };

  const renderSecretContent = () => {
    const targetUser = onlineUsers.find(u => u.id === secretTargetId);
    const selectorUser = onlineUsers.find(u => u.id === secretSelectorId);
    // The selector picks who answers; admin can always assign as a host override
    const canAssign = isAdmin || (currentUserId && currentUserId === secretSelectorId);

    if (!secretTargetId) {
      const pendingPanel = (
        <div style={cardStyle}>
          <div style={{ fontSize: '4rem', marginBottom: '0.5rem' }}>🐱</div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: '#ffd600', marginBottom: '1rem', textShadow: '0 0 20px rgba(255, 214, 0, 0.4)' }}>
            Кіт у мішку!
          </div>
          <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            {canAssign
              ? 'Оберіть гравця, який відповідатиме:'
              : selectorUser
                ? `${selectorUser.name} обирає, хто відповідатиме...`
                : 'Очікуємо вибору, хто відповідатиме...'}
          </div>
          {/* Everyone sees the candidates; only the selector and admin can click */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {onlineUsers.filter(u => u.id !== secretSelectorId).map(u => (
              <div
                key={u.id}
                onClick={canAssign ? () => handleSecretAssign(u.id) : undefined}
                style={{
                  cursor: canAssign ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem',
                  borderRadius: '12px',
                  border: '1px solid var(--glass-border)',
                  background: 'rgba(15, 23, 42, 0.6)',
                  transition: 'all 0.2s',
                  width: '110px'
                }}
                onMouseEnter={canAssign ? e => {
                  e.currentTarget.style.border = '1px solid var(--primary)';
                  e.currentTarget.style.boxShadow = '0 0 16px var(--primary-glow)';
                } : undefined}
                onMouseLeave={canAssign ? e => {
                  e.currentTarget.style.border = '1px solid var(--glass-border)';
                  e.currentTarget.style.boxShadow = 'none';
                } : undefined}
              >
                {u.imageUrl && u.imageUrl.toLowerCase().endsWith('.mp4') ? (
                  <video
                    src={u.imageUrl}
                    style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }}
                    autoPlay loop muted playsInline
                  />
                ) : (
                  <img
                    src={u.imageUrl}
                    alt={u.name}
                    style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }}
                  />
                )}
                <span style={{ fontSize: '1rem', fontWeight: '600', textAlign: 'center', wordBreak: 'break-word' }}>
                  {u.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      );

      // Admin still sees the question below the picker; players only see the panel
      if (isAdmin) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {pendingPanel}
            {renderNormalContent()}
          </div>
        );
      }
      return pendingPanel;
    }

    // Player chosen: admins see the question right away, players wait
    // until the admin presses "Show Question"
    const showQuestionContent = isAdmin || isQuestionRevealed;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{
          ...themeHeaderStyle,
          color: '#ffd600',
          textShadow: '0 0 20px rgba(255, 214, 0, 0.4)'
        }}>
          🐱 Кіт у мішку — відповідає {targetUser ? targetUser.name : '...'}
        </div>
        {showQuestionContent ? (
          renderNormalContent()
        ) : (
          <div style={cardStyle}>
            <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
              Очікуємо, поки ведучий покаже питання...
            </div>
          </div>
        )}
      </div>
    );
  };

  const handleSubmitNumberAnswer = () => {
    const value = parseFloat(answerInput);
    if (!Number.isFinite(value) || !currentUserId) {
      return;
    }
    if (answersRevealed || timer <= 0 || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: value }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, value);
  };

  const renderCloseEnoughContent = () => {
    const myAnswer = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myAnswer !== undefined;
    const acceptingAnswers = !answersRevealed && timer > 0;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}

        {/* The correct answer stays hidden until the admin presses "Show Response",
            so the numbers can be revealed without spoiling a reusable question */}
        {isResponseRevealed && question.answer !== undefined && (
          <div style={{
            ...themeHeaderStyle,
            color: '#4ade80',
            textShadow: '0 0 20px rgba(74, 222, 128, 0.4)'
          }}>
            Правильна відповідь: {question.answer}
          </div>
        )}

        {isAdmin && !isResponseRevealed && question.answer !== undefined && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            Відповідь (бачить лише ведучий): <b style={{ color: '#4ade80' }}>{question.answer}</b>
          </div>
        )}

        {!isAdmin && (
          <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
            {hasSubmitted ? (
              <div style={{ fontSize: '1.3rem' }}>
                Ваша відповідь: <b style={{ color: 'var(--accent)' }}>{myAnswer === true ? '✓' : myAnswer}</b>
              </div>
            ) : acceptingAnswers ? (
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
                <input
                  type="number"
                  value={answerInput}
                  onChange={(e) => setAnswerInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitNumberAnswer(); }}
                  placeholder="Ваше число"
                  style={{
                    fontSize: '1.25rem',
                    padding: '0.6rem 1rem',
                    borderRadius: '8px',
                    border: '1px solid var(--glass-border)',
                    background: 'rgba(15, 23, 42, 0.6)',
                    color: 'var(--text-primary)',
                    width: '200px',
                    textAlign: 'center'
                  }}
                />
                <button
                  onClick={handleSubmitNumberAnswer}
                  className="btn-primary"
                  style={{ ...buttonStyle, opacity: Number.isFinite(parseFloat(answerInput)) ? 1 : 0.5 }}
                  disabled={!Number.isFinite(parseFloat(answerInput))}
                >
                  Відповісти
                </button>
              </div>
            ) : (
              <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
                Час вийшов — відповіді більше не приймаються
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Record the moment a player locked in their answer (same as a spacebar press)
  const recordAnswerTime = () => {
    if (hasRecordedTime || (currentUserId && userTimes[currentUserId]) || !startTime) {
      return;
    }
    const timeTaken = (Date.now() - startTime) / 1000;
    setElapsedTime(timeTaken);
    setHasRecordedTime(true);
    wsManager.sendElapsedTime(parseInt(questionId), timeTaken, currentUserId);
  };

  const handleToggleOption = (idx) => {
    if (answersRevealed || (currentUserId && numberAnswers[currentUserId] !== undefined)) {
      return;
    }
    setSelectedOptions(prev => {
      const next = new Set(prev);
      if (question.multiple) {
        if (next.has(idx)) {
          next.delete(idx);
        } else {
          next.add(idx);
        }
      } else {
        next.clear();
        next.add(idx);
      }
      return next;
    });
  };

  const handleConfirmChoice = () => {
    if (!currentUserId || selectedOptions.size === 0) {
      return;
    }
    if (answersRevealed || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    const picks = [...selectedOptions].sort((a, b) => a - b);
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: picks }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, picks);
    recordAnswerTime();
  };

  const renderChoiceContent = () => {
    const myPicks = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myPicks !== undefined;
    const showCorrect = isAdmin || isResponseRevealed;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          gap: '1rem'
        }}>
          {(question.options || []).map((option, idx) => {
            const isSelected = hasSubmitted
              ? (Array.isArray(myPicks) && myPicks.includes(idx))
              : selectedOptions.has(idx);
            const highlightCorrect = showCorrect && option.correct;

            return (
              <div
                key={idx}
                onClick={() => !isAdmin && handleToggleOption(idx)}
                style={{
                  ...cardStyle,
                  minHeight: 'auto',
                  padding: '1rem',
                  flexDirection: 'row',
                  gap: '0.75rem',
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  cursor: !isAdmin && !hasSubmitted && !answersRevealed ? 'pointer' : 'default',
                  border: highlightCorrect
                    ? '2px solid #4ade80'
                    : isSelected
                      ? '2px solid var(--primary)'
                      : '1px solid var(--glass-border)',
                  boxShadow: highlightCorrect
                    ? '0 0 16px rgba(74, 222, 128, 0.4)'
                    : isSelected
                      ? '0 0 16px var(--primary-glow)'
                      : 'var(--glass-shadow)'
                }}
              >
                <div style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: highlightCorrect ? '#4ade80' : isSelected ? 'var(--primary)' : 'rgba(15, 23, 42, 0.8)',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: '700',
                  fontSize: '0.95rem'
                }}>
                  {idx + 1}
                </div>
                <div
                  className="question-content"
                  style={{ color: '#e0e0e0', fontSize: '1.05rem', flex: 1, minWidth: 0 }}
                  dangerouslySetInnerHTML={{ __html: option.content }}
                />
                {isSelected && (
                  <div style={{ color: 'var(--primary)', fontWeight: '800', fontSize: '1.2rem', flexShrink: 0 }}>✓</div>
                )}
              </div>
            );
          })}
        </div>

        {!isAdmin && !hasSubmitted && !answersRevealed && (
          <button
            onClick={handleConfirmChoice}
            className="btn-primary"
            style={{
              ...buttonStyle,
              alignSelf: 'center',
              opacity: selectedOptions.size > 0 ? 1 : 0.5
            }}
            disabled={selectedOptions.size === 0}
          >
            Підтвердити відповідь
          </button>
        )}
        {!isAdmin && hasSubmitted && (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            Відповідь прийнято ✓
          </div>
        )}
      </div>
    );
  };

  // Keep pasted images well under the server's answer-size limit, otherwise
  // the submission is rejected silently and only its author would see it
  const MAX_ANSWER_IMAGE_CHARS = 2000000;

  const downscaleImage = (dataUrl, maxDimension, quality) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

  const compressPastedImage = async (dataUrl) => {
    if (dataUrl.length <= MAX_ANSWER_IMAGE_CHARS) {
      return dataUrl;
    }
    let result = await downscaleImage(dataUrl, 1280, 0.8);
    let maxDimension = 1280;
    // Extreme sources: keep shrinking until the answer fits
    while (result.length > MAX_ANSWER_IMAGE_CHARS && maxDimension > 320) {
      maxDimension = Math.round(maxDimension / 2);
      result = await downscaleImage(dataUrl, maxDimension, 0.7);
    }
    return result;
  };

  const handleTextPaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = async (event) => {
            if (event.target?.result) {
              const compressed = await compressPastedImage(event.target.result);
              setPastedImage(compressed);
            }
          };
          reader.readAsDataURL(blob);
          e.preventDefault();
        }
      }
    }
  };

  const handleSubmitTextAnswer = () => {
    if (!currentUserId) {
      return;
    }
    if (answersRevealed || numberAnswers[currentUserId] !== undefined) {
      return;
    }
    const value = pastedImage || textAnswerInput.trim();
    if (!value) {
      return;
    }
    setNumberAnswers(prev => ({ ...prev, [currentUserId]: value }));
    wsManager.sendNumberAnswer(parseInt(questionId), currentUserId, value);
    recordAnswerTime();
  };

  const renderTextAnswerContent = () => {
    const myAnswer = currentUserId ? numberAnswers[currentUserId] : undefined;
    const hasSubmitted = myAnswer !== undefined;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {renderNormalContent()}

        {!isAdmin && (
          <div style={{ ...cardStyle, minHeight: 'auto', padding: '1.5rem' }}>
            {hasSubmitted ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ fontSize: '1.1rem', color: 'var(--text-secondary)' }}>Ваша відповідь:</div>
                {typeof myAnswer === 'string' && myAnswer.startsWith('data:image') ? (
                  <img
                    src={myAnswer}
                    alt="answer"
                    title="Клікніть, щоб переглянути у повному розмірі"
                    onClick={() => setLightboxImage(myAnswer)}
                    style={{ maxWidth: '300px', maxHeight: '200px', borderRadius: '8px', cursor: 'zoom-in' }}
                  />
                ) : (
                  <div style={{ fontSize: '1.2rem', color: 'var(--accent)', fontWeight: '700', wordBreak: 'break-word' }}>
                    {myAnswer === true ? '✓' : myAnswer}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', alignItems: 'center' }}>
                {pastedImage ? (
                  <div style={{ position: 'relative' }}>
                    <img
                      src={pastedImage}
                      alt="pasted"
                      title="Клікніть, щоб переглянути у повному розмірі"
                      onClick={() => setLightboxImage(pastedImage)}
                      style={{ maxWidth: '300px', maxHeight: '200px', borderRadius: '8px', cursor: 'zoom-in' }}
                    />
                    <button
                      onClick={() => setPastedImage(null)}
                      style={{
                        position: 'absolute',
                        top: '-10px',
                        right: '-10px',
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        background: '#ef4444',
                        color: '#fff',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                      }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <textarea
                    value={textAnswerInput}
                    onChange={(e) => setTextAnswerInput(e.target.value)}
                    onPaste={handleTextPaste}
                    placeholder="Введіть відповідь або вставте зображення (Ctrl+V)..."
                    rows={3}
                    style={{
                      width: '100%',
                      maxWidth: '600px',
                      fontSize: '1.1rem',
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      border: '1px solid var(--glass-border)',
                      background: 'rgba(15, 23, 42, 0.6)',
                      color: 'var(--text-primary)',
                      resize: 'vertical',
                      fontFamily: 'inherit'
                    }}
                  />
                )}
                <button
                  onClick={handleSubmitTextAnswer}
                  className="btn-primary"
                  style={{
                    ...buttonStyle,
                    opacity: (pastedImage || textAnswerInput.trim()) ? 1 : 0.5
                  }}
                  disabled={!pastedImage && !textAnswerInput.trim()}
                >
                  Відповісти
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Maps elapsed-time fraction to reveal fraction.
  // slow-start keeps the image hidden longer; fast-start uncovers a lot early.
  const applyRevealCurve = (progress, curve) => {
    if (curve === 'slow-start') return progress * progress;
    if (curve === 'fast-start') return Math.sqrt(progress);
    return progress;
  };

  const renderProgressiveRevealContent = () => {
    const revealDuration = question.duration || 60;
    const rawProgress = revealDuration > 0 ? Math.max(0, Math.min(1, 1 - timer / revealDuration)) : 1;
    const progress = applyRevealCurve(rawProgress, question.curve);
    const buzzPending = Object.keys(userTimes).some(uid => !redJudgedUsers.has(uid));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', gap: '1.5rem' }}>
        <div className="glass-panel" style={{
          padding: '1rem 2rem',
          fontSize: '1.3rem',
          fontWeight: '700',
          color: buzzPending ? '#fbbf24' : 'var(--text-primary)',
          textAlign: 'center',
          border: buzzPending ? '1px solid #fbbf24' : '1px solid var(--glass-border)',
          width: '100%',
          maxWidth: '800px',
          boxShadow: buzzPending ? '0 0 20px rgba(251, 191, 36, 0.4)' : 'var(--glass-shadow)'
        }}>
          {progress >= 1
            ? 'Зображення повністю відкрито!'
            : buzzPending
              ? '⏸ Розкриття призупинено — хтось відповідає!'
              : 'Натисніть ПРОБІЛ, щоб відповісти — розкриття зупиниться'}
        </div>

        <div style={{
          width: '100%',
          maxWidth: '800px',
          borderRadius: '16px',
          overflow: 'hidden',
          border: '1px solid var(--glass-border)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)'
        }}>
          <ProgressiveImage
            src={question.image}
            effect={question.effect || 'blur'}
            progress={progress}
          />
        </div>

        {showAfterRound && question.after_round && question.after_round.length > 0 && (
          <div style={{ ...cardStyle, width: '100%', maxWidth: '800px', minHeight: 'auto', padding: '1.5rem' }}>
            {question.after_round.map((rule, index) => (
              <div key={index} style={{ width: '100%' }}>
                {rule.type === 'embedded' ? (
                  <div
                    className="question-content"
                    style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap' }}
                    dangerouslySetInnerHTML={{ __html: rule.content }}
                  />
                ) : (
                  renderRule(rule)
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderContent = () => {
    if (question.type === 'find-a-cat') {
      return renderFindACatContent();
    }
    if (question.type === 'secret') {
      return renderSecretContent();
    }
    if (question.type === 'close-enough') {
      return renderCloseEnoughContent();
    }
    if (question.type === 'choice') {
      return renderChoiceContent();
    }
    if (question.type === 'text-answer') {
      return renderTextAnswerContent();
    }
    if (question.type === 'progressive-reveal') {
      return renderProgressiveRevealContent();
    }
    return renderNormalContent();
  };

  const renderNormalContent = () => {
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
                    className="question-content"
                    style={{ color: '#e0e0e0', fontSize: '1.1rem', whiteSpace: 'pre-wrap', marginBottom: '8px' }}
                    dangerouslySetInnerHTML={{ __html: rule.content }}
                  />
                ))}
              </div>
            )}
            <div style={cardStyle}>
              {afterRoundRules[lastRuleIndex].type === 'embedded' ? (
                <div
                  className="question-content"
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
              className="question-content"
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
        margin: '2rem 0',
        position: 'relative',
        width: '100%',
        maxWidth: 1200,
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
        <div style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}>
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
      {/* Theme (left) — timer (always centered) — price (right) */}
      <div style={{
        width: '100%',
        maxWidth: 1200,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: '1rem',
        marginBottom: '1rem',
        padding: '0 1rem',
        boxSizing: 'border-box'
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>
          {themeName && (
            <div className="glass-panel" style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '12px',
              color: 'var(--text-primary)',
              fontWeight: '700',
              fontSize: '1.1rem',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              border: '1px solid var(--glass-border)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textShadow: '0 0 20px var(--primary-glow)'
            }}>
              {themeName}
            </div>
          )}
        </div>
        <div className="glass-panel" style={{
          fontSize: '2.5rem',
          color: 'var(--text-primary)',
          fontWeight: '800',
          padding: '0.75rem 1.5rem',
          borderRadius: '24px',
          background: 'var(--glass-bg)',
          border: '2px solid var(--primary)',
          boxShadow: '0 0 30px var(--primary-glow), var(--glass-shadow)',
          fontVariantNumeric: 'tabular-nums'
        }}>
          {timer}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', minWidth: 0 }}>
          {question.price?.text && (
            <div className="glass-panel" style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '12px',
              color: 'var(--accent)',
              fontWeight: '800',
              fontSize: '1.25rem',
              border: '1px solid var(--glass-border)',
              whiteSpace: 'nowrap',
              textShadow: '0 0 10px var(--accent-glow)'
            }}>
              {question.price.text}
            </div>
          )}
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
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {isAdmin && !isQuestionRevealed && (
          <button
            onClick={handleShowQuestion}
            className="btn-primary"
            style={buttonStyle}
          >
            Show Question
          </button>
        )}
        {isAdmin && isQuestionRevealed && !isAnswerRevealed && (
          <button
            onClick={handleShowAnswer}
            className="btn-primary"
            style={buttonStyle}
          >
            Show Answer
          </button>
        )}
        {isAdmin && ['close-enough', 'choice', 'text-answer'].includes(question.type) && isQuestionRevealed && !answersRevealed && (
          <button
            onClick={() => wsManager.sendRevealNumberAnswers(parseInt(questionId))}
            className="btn-primary"
            style={buttonStyle}
          >
            Show Result
          </button>
        )}
        {isAdmin && isAnswerRevealed && !isResponseRevealed && (
          (question.type === 'close-enough' || question.type === 'choice')
            ? answersRevealed // submissions first, then the correct answer
            : question.after_round && question.after_round.length > 0
        ) && (
          <button
            onClick={handleShowAfterRound}
            className="btn-primary"
            style={buttonStyle}
          >
            Show Response
          </button>
        )}
        {isAdmin && (
          <button
            onClick={handleReturnToGame}
            className="btn-primary"
            style={{
              ...buttonStyle,
              background: 'linear-gradient(135deg, #ef4444, #dc2626)',
              boxShadow: '0 4px 12px rgba(239, 68, 68, 0.4)'
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
          secretTargetId={question?.type === 'secret' ? secretTargetId : null}
          clicksLeftMap={clicksLeftMap}
          numberAnswers={numberAnswers}
          answersRevealed={answersRevealed}
          responseRevealed={isResponseRevealed}
        />
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} isAdmin={isAdmin} />}
      <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
};

export default QuestionPage; 
