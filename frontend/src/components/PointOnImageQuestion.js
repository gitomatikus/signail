import React, { useMemo, useRef, useState } from 'react';
import {
  DEFAULT_POINT_ACCURACY_PERCENT,
  getImageSpace,
  layoutPointHintLabels,
  pointCorrectnessRadius,
} from '../utils/pointOnImage';
import { useTranslation } from '../i18n/LanguageContext';
import { compactPlayerName, getPlayerColor } from '../utils/playerIdentity';

const PointOnImageQuestion = ({
  question,
  users,
  currentUserId,
  isAdmin,
  timer,
  answers,
  hints,
  revealed,
  onSubmit,
}) => {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const [loadedAspect, setLoadedAspect] = useState(null);
  const aspect = loadedAspect || Number(question.image_aspect_ratio) || 1;
  const space = useMemo(() => getImageSpace(aspect), [aspect]);
  const correctnessRadius = useMemo(
    () => pointCorrectnessRadius(question.accuracy_percent, aspect),
    [question.accuracy_percent, aspect]
  );
  const myAnswer = currentUserId ? answers[currentUserId] : null;
  const canAnswer = !isAdmin && !revealed && timer > 0 && currentUserId && !myAnswer;
  const userById = useMemo(() => Object.fromEntries(users.map((user) => [user.id, user])), [users]);

  const submitClick = (event) => {
    if (!canAnswer) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    onSubmit({
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
  };

  const exactEntries = revealed
    ? Object.entries(answers)
    : (myAnswer ? [[currentUserId, myAnswer]] : []);
  const hintEntries = revealed
    ? []
    : Object.entries(hints).filter(([userId]) => userId !== currentUserId);
  const hintLabels = layoutPointHintLabels(hintEntries.map(([userId, hint]) => ({
    userId,
    x: hint.x * space.width,
    y: hint.y * space.height,
    radius: hint.radius || 0.12,
    label: compactPlayerName(userById[userId]?.name || '?'),
  })), space);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem', width: '100%' }}>
      <div className="glass-panel" style={{
        padding: '1rem 2rem',
        fontSize: '1.4rem',
        fontWeight: 700,
        textAlign: 'center',
        width: '100%',
        maxWidth: 900,
        border: '1px solid var(--glass-border)'
      }}>
        {question.task && <div>{question.task}</div>}
        {question.prompt_image && (
          <img
            src={question.prompt_image}
            alt={question.task || 'Visual prompt'}
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: '38vh',
              width: 'auto',
              height: 'auto',
              margin: question.task ? '1rem auto 0' : '0 auto',
              borderRadius: 12,
              border: '1px solid var(--glass-border)',
              objectFit: 'contain',
            }}
          />
        )}
        {!isAdmin && (
          <div style={{ marginTop: question.task || question.prompt_image ? '.75rem' : 0, color: 'var(--text-secondary)', fontSize: '1rem', fontWeight: 500 }}>
            {myAnswer
              ? t('question.pointAnswerLocked')
              : timer > 0 && !revealed
                ? t('question.pointClickHint')
                : t('question.timeUp')}
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        onClick={submitClick}
        style={{
          position: 'relative',
          display: 'inline-block',
          maxWidth: '100%',
          cursor: canAnswer ? 'crosshair' : 'default',
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid var(--glass-border)',
          boxShadow: '0 12px 40px rgba(0,0,0,.6)'
        }}
      >
        <img
          src={question.image}
          alt={question.task}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth && image.naturalHeight) setLoadedAspect(image.naturalWidth / image.naturalHeight);
          }}
          style={{ display: 'block', maxWidth: '100%', maxHeight: question.prompt_image ? '48vh' : 'max(calc(100vh - 450px), 320px)', width: 'auto', height: 'auto', pointerEvents: 'none', userSelect: 'none' }}
        />
        <svg
          viewBox={`0 0 ${space.width} ${space.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden' }}
        >
          {hintLabels.map((hint) => {
            const { userId } = hint;
            const color = getPlayerColor(userById[userId] || userId);
            return (
              <g key={`hint-${userId}`}>
                <circle
                  cx={hint.x}
                  cy={hint.y}
                  r={hint.radius}
                  fill={color}
                  fillOpacity="0.2"
                  stroke={color}
                  strokeWidth="0.012"
                  strokeDasharray="0.025 0.018"
                />
                {hint.displaced && (
                  <line
                    x1={hint.x}
                    y1={hint.y}
                    x2={hint.labelX}
                    y2={hint.labelY}
                    stroke={color}
                    strokeWidth="0.008"
                    strokeOpacity="0.75"
                  />
                )}
                <rect
                  x={hint.labelX - hint.labelWidth / 2}
                  y={hint.labelY - hint.labelHeight / 2}
                  width={hint.labelWidth}
                  height={hint.labelHeight}
                  rx={hint.labelHeight / 2}
                  fill="rgba(12,18,30,.82)"
                  stroke={color}
                  strokeWidth="0.007"
                />
                <text
                  x={hint.labelX}
                  y={hint.labelY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#fff"
                  fontSize={hint.fontSize}
                  fontWeight="600"
                >
                  {hint.label}
                </text>
              </g>
            );
          })}

          {revealed && question.correct_point && (
            <g>
              <circle
                cx={question.correct_point.x * space.width}
                cy={question.correct_point.y * space.height}
                r={correctnessRadius}
                fill="#22c55e"
                fillOpacity="0.16"
                stroke="#16a34a"
                strokeWidth="0.01"
              />
              <circle
                cx={question.correct_point.x * space.width}
                cy={question.correct_point.y * space.height}
                r="0.016"
                fill="#16a34a"
                stroke="#fff"
                strokeWidth="0.008"
              />
            </g>
          )}

          {exactEntries.map(([userId, point]) => {
            const color = getPlayerColor(userById[userId] || userId);
            return (
              <g key={`point-${userId}`}>
                <circle cx={point.x * space.width} cy={point.y * space.height} r="0.025" fill={color} stroke="#fff" strokeWidth="0.012" />
                <circle cx={point.x * space.width} cy={point.y * space.height} r="0.008" fill="#fff" />
              </g>
            );
          })}

        </svg>
      </div>

      {revealed && (
        <div style={{ color: 'var(--text-secondary)', textAlign: 'center', fontSize: '.95rem' }}>
          {t('question.pointCorrectRadius', {
            value: Number(question.accuracy_percent) || DEFAULT_POINT_ACCURACY_PERCENT,
          })}
        </div>
      )}
    </div>
  );
};

export default PointOnImageQuestion;
