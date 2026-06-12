import React, { useState, useEffect } from 'react';
import wsManager from '../utils/websocket';
import { useLocation } from 'react-router-dom';
import ImageLightbox from './ImageLightbox';
import { useGame } from '../contexts/GameContext';
import { HIDE_HOST_KEY, HIDE_HOST_EVENT } from '../utils/hostVisibility';
import { useTranslation } from '../i18n/LanguageContext';

const OnlineUsers = ({ users, elapsedTime, currentUserId, userTimes = {}, isAdmin = false, question, secretTargetId = null, clicksLeftMap = {}, numberAnswers = {}, answersRevealed = false, responseRevealed = false }) => {
  const location = useLocation();
  const { t } = useTranslation();
  const isQuestionPage = location.pathname.includes('/question/');
  const { gameId, gameInfo, user: contextUser } = useGame() || {};
  // The board page renders this list without a currentUserId prop — fall
  // back to the logged-in user so the own-card badge shows everywhere
  const myUserId = currentUserId ?? contextUser?.id ?? null;

  const [updatedUsers, setUpdatedUsers] = useState(new Set());
  const [penalizedUsers, setPenalizedUsers] = useState(new Set());
  const [greenFrameUsers, setGreenFrameUsers] = useState(new Set());
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [hideHost, setHideHost] = useState(() => localStorage.getItem(HIDE_HOST_KEY) === 'true');

  useEffect(() => {
    const storedGreenFramedUsers = JSON.parse(localStorage.getItem(`greenFramedUsers-${gameId}`) || '[]');
    if (!isQuestionPage) {
      setGreenFrameUsers(new Set(storedGreenFramedUsers));
    }
  }, [isQuestionPage, gameId]);

  // React immediately when the player toggles "hide host" in Settings
  useEffect(() => {
    const onToggle = () => setHideHost(localStorage.getItem(HIDE_HOST_KEY) === 'true');
    window.addEventListener(HIDE_HOST_EVENT, onToggle);
    return () => window.removeEventListener(HIDE_HOST_EVENT, onToggle);
  }, []);

  useEffect(() => {
    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'admin_clicked_red_number') {
        setPenalizedUsers(prev => new Set([...prev, data.data.userId]));
      } else if (data.type === 'admin_clicked_green_number') {
        setGreenFrameUsers(prev => {
          const newSet = new Set([data.data.userId]);
          localStorage.setItem(`greenFramedUsers-${gameId}`, JSON.stringify([data.data.userId]));
          return newSet;
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [gameId]);

  const sortedUsers = [...users].sort((a, b) => {
    const timeA = userTimes[a.id] ?? (a.id === currentUserId ? elapsedTime : null);
    const timeB = userTimes[b.id] ?? (b.id === currentUserId ? elapsedTime : null);

    if (timeA === null && timeB === null) return 0;
    if (timeA === null) return 1;
    if (timeB === null) return -1;

    return timeA - timeB;
  });

  const topThreeTimes = sortedUsers
    .filter(user => (userTimes[user.id] !== undefined || (user.id === currentUserId && elapsedTime !== null)) && !penalizedUsers.has(user.id))
    .slice(0, 3)
    .map(user => user.id);

  const correctValue = question?.price?.correct ?? 0;
  const incorrectValue = question?.price?.incorrect ?? 0;
  const hasClickLimit = question?.type === 'find-a-cat' && Number(question?.max_clicks) > 0;
  const isCloseEnoughQuestion = question?.type === 'close-enough';
  const isChoiceQuestion = question?.type === 'choice';
  const isTextQuestion = question?.type === 'text-answer';

  // Close-enough: once numbers are revealed, find who came closest to the answer
  let closestIds = [];
  if (isCloseEnoughQuestion && answersRevealed && typeof question?.answer === 'number') {
    let bestDistance = Infinity;
    Object.entries(numberAnswers).forEach(([userId, value]) => {
      if (typeof value !== 'number') return;
      const distance = Math.abs(value - question.answer);
      if (distance < bestDistance) {
        bestDistance = distance;
        closestIds = [userId];
      } else if (distance === bestDistance) {
        closestIds.push(userId);
      }
    });
  }

  // Choice: exact-match correctness, plus the fastest correct player (takes the move).
  // Choice picks arrive unmasked in real time, so this works before the reveal
  // for the admin; players only have masked values until then.
  const choiceCorrectKey = isChoiceQuestion
    ? (question.options || []).map((o, i) => (o.correct ? i : -1)).filter(i => i >= 0).join(',')
    : '';
  const isCorrectChoicePicks = (value) =>
    Array.isArray(value) && [...value].sort((a, b) => a - b).join(',') === choiceCorrectKey;
  let fastestCorrectChoiceId = null;
  if (isChoiceQuestion) {
    let bestTime = Infinity;
    Object.entries(numberAnswers).forEach(([userId, value]) => {
      if (!isCorrectChoicePicks(value)) return;
      const time = userTimes[userId];
      if (typeof time === 'number' && time < bestTime) {
        bestTime = time;
        fastestCorrectChoiceId = userId;
      }
    });
  }

  const handleGrantClick = (userId) => {
    if (!isAdmin || !question) return;
    wsManager.sendCatClicksGrant(question.id, userId, 1);
  };

  const handleScoreClick = (userId, currentScore, value, grantsMove = true) => {
    if (!isAdmin) return;

    const newScore = currentScore + value;
    wsManager.sendUpdateScore(userId, newScore);

    if (value > 0) {
      setUpdatedUsers(prev => new Set([...prev, userId]));
      if (grantsMove) {
        wsManager.sendAdminClickedGreenNumber(userId);
      }
    } else {
      setPenalizedUsers(prev => new Set([...prev, userId]));
      wsManager.sendAdminClickedRedNumber(userId);
    }
  };

  return (
    <div style={{
      width: '100%',
      boxSizing: 'border-box',
      display: 'flex',
      justifyContent: 'center',
      // Tight gap so 9+ players and the host fit in a single row on a desktop
      gap: '0.75rem',
      flexWrap: 'wrap',
      minHeight: '250px',
      alignItems: 'flex-start',
      padding: '1rem'
    }}>
      <style>{`
        @keyframes rainbowShift {
          0% { background-position: 0% 50%, 0% 50%; }
          100% { background-position: 0% 50%, 200% 50%; }
        }
        .rainbow-frame {
          border: 3px solid transparent;
          background-image:
            linear-gradient(var(--bg-dark), var(--bg-dark)),
            linear-gradient(90deg, #ff0040, #ff8c00, #ffd700, #00e676, #00b0ff, #d500f9, #ff0040);
          background-origin: border-box;
          background-clip: padding-box, border-box;
          background-size: auto, 200% 100%;
          animation: rainbowShift 2s linear infinite;
          box-shadow: 0 0 25px rgba(213, 0, 249, 0.6);
        }
      `}</style>
      {users.map(user => {
        const userTime = userTimes[user.id] ?? (user.id === currentUserId ? elapsedTime : null);
        const isTopThree = topThreeTimes.includes(user.id);
        const position = topThreeTimes.indexOf(user.id);
        const numericScore = Number(user.score ?? 0);
        const previousScore = Number.isFinite(numericScore) ? numericScore : 0;
        const isUpdated = updatedUsers.has(user.id);
        const isPenalized = penalizedUsers.has(user.id);
        const hasGreenFrame = greenFrameUsers.has(user.id);
        const clicksLeft = hasClickLimit ? (clicksLeftMap[user.id] ?? question.max_clicks) : null;
        const hasFailedClicks = hasClickLimit && clicksLeft <= 0 && userTime === null;
        const isFindACat = question?.type === 'find-a-cat';
        // Who gets award buttons: the chosen player for cat-in-the-bag,
        // every finisher for find-a-cat, every user once close-enough numbers
        // are revealed, every answerer for choice/text, the fastest player otherwise
        const showAwardRow = isAdmin && !isUpdated && !isPenalized && (
          secretTargetId
            ? user.id === secretTargetId
            : isFindACat
              ? userTime !== null
              : isCloseEnoughQuestion
                ? answersRevealed
                : isChoiceQuestion
                  // Choice results are live: award as soon as the player answers
                  ? numberAnswers[user.id] !== undefined
                  : isTextQuestion
                    ? (answersRevealed && numberAnswers[user.id] !== undefined)
                    : position === 0
        );
        const submittedAnswer = numberAnswers[user.id];
        const answerBadge = isCloseEnoughQuestion && submittedAnswer !== undefined
          ? (typeof submittedAnswer === 'number' ? submittedAnswer : '✓')
          : null;
        // Exact close-enough guess: rainbow frame + optional bonus points
        const isPerfectGuess = isCloseEnoughQuestion && answersRevealed
          && typeof question?.answer === 'number' && submittedAnswer === question.answer;
        // First-place bonus for multi-winner types: the fastest find-a-cat solver,
        // the fastest correct choice answer, the fastest (non-penalized) text answerer
        const isFirstPlace = isFindACat
          ? position === 0
          : isChoiceQuestion
            ? user.id === fastestCorrectChoiceId
            : isTextQuestion
              ? (answersRevealed && position === 0)
              : false;
        const firstPlaceBonus = isFirstPlace ? (Number(question?.first_place_bonus) || 0) : 0;
        const perfectBonus = isPerfectGuess ? (Number(question?.perfect_bonus) || 0) : 0;
        const awardValue = correctValue + firstPlaceBonus + perfectBonus;
        // Who takes the move (green frame) when awarded points
        const grantsMove = isFindACat
          ? position === 0
          : isCloseEnoughQuestion
            ? closestIds.includes(user.id)
            : isChoiceQuestion
              ? user.id === fastestCorrectChoiceId
              : true;

        const getFrameStyle = () => {
          if (hasGreenFrame) {
            return {
              border: '3px solid #4ade80',
              boxShadow: '0 0 20px rgba(74, 222, 128, 0.6)'
            };
          }

          if (isPenalized) {
            return {
              border: '3px solid #ef4444',
              boxShadow: '0 0 20px rgba(239, 68, 68, 0.6)'
            };
          }

          // Player ran out of find-a-cat clicks without finding everything
          if (hasFailedClicks) {
            return {
              border: '3px solid #ef4444',
              boxShadow: '0 0 20px rgba(239, 68, 68, 0.6)'
            };
          }

          // Highlight the player chosen to answer a cat-in-the-bag question
          if (secretTargetId && user.id === secretTargetId) {
            return {
              border: '3px solid #ffd600',
              boxShadow: '0 0 25px rgba(255, 214, 0, 0.6)'
            };
          }

          // Close-enough winner: the number closest to the correct answer
          if (isCloseEnoughQuestion && answersRevealed && closestIds.includes(user.id)) {
            return {
              border: '3px solid #fbbf24',
              boxShadow: '0 0 25px rgba(251, 191, 36, 0.6)'
            };
          }

          if (!isTopThree) {
            if (userTime === null) {
              return {
                border: '3px solid rgba(255, 255, 255, 0.1)',
                boxShadow: 'none'
              };
            }
            return {
              border: '3px solid var(--text-muted)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
            };
          }

          switch (position) {
            case 0: // Gold
              return {
                border: '3px solid #fbbf24',
                boxShadow: '0 0 25px rgba(251, 191, 36, 0.6)'
              };
            case 1: // Silver
              return {
                border: '3px solid #e2e8f0',
                boxShadow: '0 0 20px rgba(226, 232, 240, 0.5)'
              };
            case 2: // Bronze
              return {
                border: '3px solid #d97706',
                boxShadow: '0 0 20px rgba(217, 119, 6, 0.5)'
              };
            default:
              return {
                border: '3px solid rgba(255, 255, 255, 0.1)',
                boxShadow: 'none'
              };
          }
        };

        return (
          <div
            key={user.id || user.name}
            className="fade-in"
            style={{
              width: '124px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              position: 'relative',
            }}
          >
            {userTime !== null && (
              <div style={{
                position: 'absolute',
                top: -20,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'var(--primary)',
                color: 'var(--on-primary)',
                padding: '4px 12px',
                borderRadius: '9999px',
                fontSize: '1rem',
                fontWeight: 'bold',
                zIndex: 10,
                boxShadow: '0 4px 12px var(--primary-glow)'
              }}>
                {typeof userTime === 'number' ? userTime.toFixed(3) : userTime}s
              </div>
            )}

            {/* Close-enough: a checkmark while numbers are hidden, the number once revealed */}
            {answerBadge !== null && (
              <div style={{
                position: 'absolute',
                top: -20,
                left: '50%',
                transform: 'translateX(-50%)',
                background: isPerfectGuess
                  ? 'linear-gradient(90deg, #ff0040, #ff8c00, #ffd700, #00e676, #00b0ff, #d500f9)'
                  : answersRevealed && closestIds.includes(user.id) ? '#fbbf24' : 'var(--primary)',
                color: isPerfectGuess ? '#fff' : 'var(--on-primary)',
                padding: '4px 12px',
                borderRadius: '9999px',
                fontSize: '1rem',
                fontWeight: 'bold',
                zIndex: 10,
                whiteSpace: 'nowrap',
                textShadow: isPerfectGuess ? '0 1px 2px rgba(0,0,0,0.6)' : 'none',
                boxShadow: '0 4px 12px var(--primary-glow)'
              }}>
                {answerBadge}
              </div>
            )}

            <div
              className={isPerfectGuess ? 'rainbow-frame' : undefined}
              style={{
                width: '110px',
                height: '110px',
                borderRadius: '24px',
                overflow: 'hidden',
                marginBottom: '1rem',
                transition: 'all 0.3s ease',
                // The rainbow frame paints its own background and border
                ...(isPerfectGuess ? {} : { background: 'var(--bg-dark)', ...getFrameStyle() })
              }}>
              {user.imageUrl.toLowerCase().endsWith('.mp4') ? (
                <video
                  src={user.imageUrl}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  autoPlay loop muted playsInline
                />
              ) : (
                <img
                  src={user.imageUrl}
                  alt={user.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (isAdmin) {
                      wsManager.sendAdminClickedGreenNumber(user.id);
                    }
                  }}
                />
              )}
            </div>

            <span style={{
              fontWeight: '600',
              fontSize: '1.25rem',
              color: 'var(--text-primary)',
              marginBottom: '0.5rem',
              textAlign: 'center',
              wordBreak: 'break-word',
              textShadow: '0 2px 4px rgba(0,0,0,0.3)'
            }}>
              {user.name}
              {myUserId && user.id === myUserId && (
                <span style={{
                  display: 'inline-block',
                  verticalAlign: 'middle',
                  marginLeft: '6px',
                  fontSize: '0.6rem',
                  fontWeight: '700',
                  letterSpacing: '0.1em',
                  lineHeight: 1.4,
                  color: 'var(--on-primary)',
                  background: 'var(--primary)',
                  borderRadius: '9999px',
                  padding: '1px 7px',
                  textShadow: 'none'
                }}>
                  {t('users.you')}
                </span>
              )}
            </span>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <span
                contentEditable={isAdmin}
                suppressContentEditableWarning={true}
                onBlur={(e) => {
                  const newScore = e.target.textContent.trim();
                  const parsedScore = Number(newScore);
                  if (newScore !== '' && Number.isFinite(parsedScore)) {
                    wsManager.sendUpdateScore(user.id, parsedScore);
                    e.target.textContent = parsedScore;
                  } else {
                    e.target.textContent = previousScore;
                  }
                }}
                style={{
                  fontWeight: '700',
                  fontSize: '1.5rem',
                  color: 'var(--accent)',
                  textAlign: 'center',
                  textShadow: '0 0 10px var(--accent-glow)'
                }}
              >
                {previousScore}
              </span>

              {/* Award buttons: chosen player for cat-in-the-bag, every finisher for find-a-cat (only +X), fastest player otherwise */}
              {showAwardRow && (
                <div className="glass-panel" style={{
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '4px 8px',
                  marginTop: '4px',
                  borderRadius: '8px',
                  whiteSpace: 'nowrap'
                }}>
                  {!isFindACat && (
                    <>
                      <span
                        onClick={() => handleScoreClick(user.id, previousScore, incorrectValue)}
                        style={{
                          fontWeight: 'bold',
                          fontSize: '1rem',
                          color: '#ef4444',
                          cursor: 'pointer',
                          transition: 'opacity 0.2s'
                        }}
                        onMouseEnter={e => e.target.style.opacity = '0.8'}
                        onMouseLeave={e => e.target.style.opacity = '1'}
                      >
                        {incorrectValue}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>/</span>
                    </>
                  )}
                  <span
                    onClick={() => handleScoreClick(user.id, previousScore, awardValue, grantsMove)}
                    title={
                      firstPlaceBonus > 0
                        ? t('users.firstPlaceBonus', { value: correctValue, bonus: firstPlaceBonus })
                        : perfectBonus > 0
                          ? t('users.perfectBonus', { value: correctValue, bonus: perfectBonus })
                          : ''
                    }
                    style={{
                      fontWeight: 'bold',
                      fontSize: '1rem',
                      color: '#4ade80',
                      cursor: 'pointer',
                      transition: 'opacity 0.2s'
                    }}
                    onMouseEnter={e => e.target.style.opacity = '0.8'}
                    onMouseLeave={e => e.target.style.opacity = '1'}
                  >
                    {isFindACat
                      ? `+${awardValue}${firstPlaceBonus > 0 ? ' 🥇' : ''}`
                      : perfectBonus > 0
                        ? `+${awardValue} 🎯`
                        : firstPlaceBonus > 0
                          ? `+${awardValue} 🥇`
                          : correctValue}
                  </span>
                </div>
              )}

              {/* Find-a-cat click budget: counter, penalty button for a failed player, admin click grant */}
              {hasClickLimit && (
                <div className="glass-panel" style={{
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                  padding: '4px 8px',
                  marginTop: '4px',
                  borderRadius: '8px'
                }}>
                  <span style={{
                    fontWeight: 'bold',
                    fontSize: '0.95rem',
                    color: clicksLeft <= 0 ? '#ef4444' : 'var(--text-secondary)'
                  }}>
                    🖱 {clicksLeft}
                  </span>
                  {isAdmin && hasFailedClicks && !isPenalized && !isUpdated && (
                    <span
                      onClick={() => handleScoreClick(user.id, previousScore, incorrectValue)}
                      style={{
                        fontWeight: 'bold',
                        fontSize: '1rem',
                        color: '#ef4444',
                        cursor: 'pointer',
                        transition: 'opacity 0.2s'
                      }}
                      onMouseEnter={e => e.target.style.opacity = '0.8'}
                      onMouseLeave={e => e.target.style.opacity = '1'}
                    >
                      {incorrectValue}
                    </span>
                  )}
                  {isAdmin && (
                    <span
                      onClick={() => handleGrantClick(user.id)}
                      title={t('users.grantClick')}
                      style={{
                        fontWeight: 'bold',
                        fontSize: '0.95rem',
                        color: '#4ade80',
                        cursor: 'pointer',
                        transition: 'opacity 0.2s',
                        whiteSpace: 'nowrap'
                      }}
                      onMouseEnter={e => e.target.style.opacity = '0.8'}
                      onMouseLeave={e => e.target.style.opacity = '1'}
                    >
                      {t('users.plusOneClick')}
                    </span>
                  )}
                </div>
              )}

              {/* Choice picks / text answers shown under the player once revealed —
                  for the admin, choice picks appear in real time. Correctness colors
                  appear for the admin right away and for players only after the
                  admin shows the response. */}
              {(isChoiceQuestion || isTextQuestion) && (answersRevealed || (isAdmin && isChoiceQuestion))
                && submittedAnswer !== undefined && submittedAnswer !== true && (
                <div className="glass-panel" style={{
                  marginTop: '4px',
                  padding: '6px 10px',
                  borderRadius: '8px',
                  maxWidth: '140px',
                  border: isChoiceQuestion && (isAdmin || responseRevealed)
                    ? (isCorrectChoicePicks(submittedAnswer) ? '1px solid #4ade80' : '1px solid #ef4444')
                    : '1px solid var(--glass-border)'
                }}>
                  {isChoiceQuestion ? (
                    <span style={{
                      fontWeight: '700',
                      fontSize: '1rem',
                      color: (isAdmin || responseRevealed)
                        ? (isCorrectChoicePicks(submittedAnswer) ? '#4ade80' : '#ef4444')
                        : 'var(--accent)'
                    }}>
                      {Array.isArray(submittedAnswer) ? submittedAnswer.map(i => i + 1).join(', ') : ''}
                    </span>
                  ) : typeof submittedAnswer === 'string' && submittedAnswer.startsWith('data:image') ? (
                    <img
                      src={submittedAnswer}
                      alt="answer"
                      title={t('question.clickToEnlarge')}
                      onClick={() => setLightboxSrc(submittedAnswer)}
                      style={{ maxWidth: '120px', maxHeight: '90px', borderRadius: '6px', display: 'block', cursor: 'zoom-in' }}
                    />
                  ) : (
                    <div style={{
                      fontSize: '0.9rem',
                      color: 'var(--text-primary)',
                      wordBreak: 'break-word',
                      maxHeight: '80px',
                      overflowY: 'auto'
                    }}>
                      {submittedAnswer}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Host card: shown to the right of the players, separated by a divider.
          When the row wraps, the host lands on the last line - the divider and
          the HOST badge keep them visually distinct. Players can hide this
          in Settings. */}
      {gameInfo && !hideHost && (
        <div
          className="fade-in"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            borderLeft: '2px solid var(--glass-border)',
            paddingLeft: '0.75rem',
            marginLeft: '0.25rem'
          }}
        >
          <div style={{
            width: '124px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            position: 'relative'
          }}>
            <div style={{
              width: '110px',
              height: '110px',
              borderRadius: '24px',
              overflow: 'hidden',
              marginBottom: '1rem',
              background: 'var(--bg-dark)',
              border: '3px solid var(--accent)',
              boxShadow: '0 0 20px var(--accent-glow)',
              opacity: gameInfo.hostOnline === false ? 0.5 : 1
            }}>
              {gameInfo.hostImageUrl ? (
                gameInfo.hostImageUrl.toLowerCase().endsWith('.mp4') ? (
                  <video
                    src={gameInfo.hostImageUrl}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    autoPlay loop muted playsInline
                  />
                ) : (
                  <img
                    src={gameInfo.hostImageUrl}
                    alt={gameInfo.hostName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                )
              ) : null}
            </div>
            <span style={{
              fontWeight: '600',
              fontSize: '1.25rem',
              color: 'var(--text-primary)',
              marginBottom: '0.25rem',
              textAlign: 'center',
              wordBreak: 'break-word',
              textShadow: '0 2px 4px rgba(0,0,0,0.3)'
            }}>
              {gameInfo.hostName}
            </span>
            <span style={{
              fontSize: '0.75rem',
              fontWeight: '700',
              letterSpacing: '0.15em',
              color: 'var(--accent)',
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              borderRadius: '9999px',
              padding: '2px 10px'
            }}>
              {t('users.host')}
            </span>
          </div>
        </div>
      )}

      <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  );
};

export default OnlineUsers;
