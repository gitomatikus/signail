import React, { useEffect, useMemo, useRef, useState } from 'react';
import wsManager from '../utils/websocket';
import { useTranslation } from '../i18n/LanguageContext';
import { useGame } from '../contexts/GameContext';
import {
  buildSpectrumScoreSuggestions,
  formatSpectrumPoints,
  getSpectrumSegments,
  SPECTRUM_ZONE_COLORS,
  SPECTRUM_ZONE_MULTIPLIERS,
  wrapSpectrumPosition,
} from '../utils/spectrum';
import { getPlayerColor } from '../utils/playerIdentity';
import { answersNeedNoConfirmation } from '../utils/answerSettings';

const emptyState = {
  phase: 'assigning', selectorId: null, clueGiverId: null, clueMode: null, clue: null,
  submittedUserIds: [], revealed: false, target: null, guesses: {}, guessTimes: {},
  ownGuess: null, hostSubmitted: false, hostGuess: null, hostGuessTime: null, guessingEndsAt: null,
};

const SpectrumTrack = ({
  question,
  target,
  colored = false,
  markers = [],
  value = null,
  onChange = null,
  showTarget = false,
  markerColor = '#f97316',
  markerLabel = '',
  previousValue = null,
  onCommit = null,
}) => {
  const { t } = useTranslation();
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const segments = colored && Number.isFinite(Number(target))
    ? getSpectrumSegments(
        Number(target),
        question.spectrum_range || 20,
        question.price?.correct || 0,
        question.spectrum_risk_mode || 'risk'
      )
    : [];
  const baseScore = Math.abs(Number(question.price?.correct) || 0);

  const updateFromPointer = (event) => {
    if (!onChange || !trackRef.current) return null;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const next = Math.round(Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)) * 10) / 10;
    onChange(next);
    return next;
  };

  const zoneHeight = 82;
  const previousPosition = previousValue !== null && Number.isFinite(Number(previousValue))
    ? wrapSpectrumPosition(Number(previousValue))
    : null;
  const currentPosition = value !== null && Number.isFinite(Number(value))
    ? wrapSpectrumPosition(Number(value))
    : null;
  const previousDistance = previousPosition !== null && currentPosition !== null
    ? Math.min(Math.abs(previousPosition - currentPosition), 100 - Math.abs(previousPosition - currentPosition))
    : 0;
  const showPreviousValue = !!onChange && previousPosition !== null && previousDistance > 0.05;

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 12, fontWeight: 750, fontSize: 'clamp(.95rem, 2vw, 1.2rem)' }}>
        <span>{question.spectrum_left}</span>
        <span style={{ textAlign: 'right' }}>{question.spectrum_right}</span>
      </div>
      <div
        ref={trackRef}
        role={onChange ? 'slider' : undefined}
        aria-label={onChange ? t('spectrum.placeMarker') : t('spectrum.resultScale')}
        aria-valuemin={onChange ? 0 : undefined}
        aria-valuemax={onChange ? 100 : undefined}
        aria-valuenow={onChange && value !== null ? value : undefined}
        tabIndex={onChange ? 0 : undefined}
        onKeyDown={event => {
          if (!onChange || value === null) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const next = wrapSpectrumPosition(value + (event.key === 'ArrowLeft' ? -1 : 1));
            onChange(next);
            if (onCommit) onCommit(next);
          }
        }}
        onPointerDown={event => {
          if (!onChange) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event);
        }}
        onPointerMove={event => { if (draggingRef.current) updateFromPointer(event); }}
        onPointerUp={event => {
          const finalPosition = draggingRef.current ? updateFromPointer(event) : null;
          draggingRef.current = false;
          if (onCommit && finalPosition !== null) onCommit(finalPosition);
        }}
        onPointerCancel={() => { draggingRef.current = false; }}
        style={{
          height: markers.length > 0 ? 154 : zoneHeight,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 16,
          border: `1px solid ${onChange ? `${markerColor}99` : 'var(--glass-border)'}`,
          background: colored
            ? '#151a18'
            : 'linear-gradient(90deg, rgba(99,102,241,.13), rgba(148,163,184,.08) 50%, rgba(236,72,153,.13))',
          cursor: onChange ? 'ew-resize' : 'default',
          touchAction: 'none',
          userSelect: 'none',
          boxShadow: onChange
            ? `inset 0 1px 12px rgba(0,0,0,.32), 0 0 0 3px ${markerColor}18`
            : 'inset 0 1px 12px rgba(0,0,0,.32)',
        }}
      >
        {!colored && [25, 50, 75].map(tick => (
          <div key={tick} style={{
            position: 'absolute', left: `${tick}%`, top: 14, bottom: 14, width: 1,
            background: 'rgba(255,255,255,.09)',
          }} />
        ))}
        {segments.map((segment, index) => (
          <div key={`${segment.start}-${segment.end}-${index}`} style={{
            position: 'absolute', left: `${segment.start}%`, width: `${segment.end - segment.start}%`,
            top: 0,
            height: zoneHeight,
            background: segment.multiplier < 0
              ? `linear-gradient(rgba(75, 85, 99, 0.48), rgba(75, 85, 99, 0.48)), ${segment.color}`
              : segment.color,
            borderRight: '1px solid rgba(0,0,0,.2)',
            display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
            color: segment.multiplier < 0 ? '#f3f4f6' : '#152011',
            fontWeight: 900,
            fontSize: 'clamp(.62rem, 1.2vw, .82rem)',
            whiteSpace: 'nowrap',
            textShadow: segment.multiplier < 0
              ? '0 1px 2px rgba(0,0,0,.65)'
              : '0 1px 1px rgba(255,255,255,.4)',
          }}>
            {segment.end - segment.start >= 5 ? segment.label : ''}
          </div>
        ))}
        {showTarget && Number.isFinite(Number(target)) && (
          <div style={{
            position: 'absolute', left: `${target}%`, top: 0, height: zoneHeight, width: 3,
            transform: 'translateX(-1.5px)', background: '#fff',
            boxShadow: '0 0 9px rgba(0,0,0,.9)', zIndex: 3,
          }} />
        )}
        {showPreviousValue && (
          <div style={{
            position: 'absolute', left: `${previousPosition}%`, top: 0, height: zoneHeight, width: 3,
            transform: 'translateX(-1.5px)', background: '#9ca3af',
            boxShadow: '0 0 8px rgba(156,163,175,.75)', opacity: .8, zIndex: 3,
          }}>
            <div style={{
              position: 'absolute', top: '50%', left: '50%', width: 17, height: 17,
              borderRadius: '50%', transform: 'translate(-50%, -50%)',
              background: '#4b5563', border: '3px solid #d1d5db',
              boxShadow: '0 2px 8px rgba(0,0,0,.5)',
            }} />
          </div>
        )}
        {value !== null && Number.isFinite(Number(value)) && (
          <div style={{
            position: 'absolute', left: `${value}%`, top: 0, height: zoneHeight, width: 3,
            transform: 'translateX(-1.5px)', background: markerColor,
            boxShadow: `0 0 13px ${markerColor}`, zIndex: 4,
          }}>
            <div style={{
              position: 'absolute', top: '50%', left: '50%', width: 22, height: 22,
              borderRadius: '50%', transform: 'translate(-50%, -50%)',
              background: markerColor, border: '3px solid #fff',
              boxShadow: `0 3px 12px rgba(0,0,0,.55), 0 0 14px ${markerColor}`,
            }} />
            {markerLabel && (
              <div style={{
                position: 'absolute', left: '50%', top: 7, transform: 'translateX(-50%)',
                maxWidth: 120, padding: '3px 7px', borderRadius: 7,
                background: 'rgba(10,12,18,.82)', border: `1px solid ${markerColor}`,
                color: '#fff', fontSize: '.7rem', fontWeight: 800,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{markerLabel}</div>
            )}
          </div>
        )}
        {markers.map((marker, index) => {
          const color = getPlayerColor(marker.user);
          const answerTime = Number.isFinite(Number(marker.time))
            ? t('spectrum.secondsShort', { value: (Number(marker.time) / 1000).toFixed(1) })
            : null;
          return (
            <div key={marker.user.id} title={`${marker.user.name}${answerTime ? ` · ${answerTime}` : ''}`} style={{
              position: 'absolute', left: `${marker.position}%`, top: 0, bottom: 0,
              transform: 'translateX(-50%)', zIndex: 5,
            }}>
              <div style={{
                position: 'absolute', left: '50%', top: 0, height: zoneHeight, width: 3,
                transform: 'translateX(-50%)', background: color,
                boxShadow: `0 0 9px ${color}`, opacity: .95,
              }} />
              <div style={{
                position: 'absolute', left: '50%', top: zoneHeight + 7 + (index % 2) * 28,
                transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 6px 3px 3px', borderRadius: 10,
                background: 'rgba(10,12,18,.9)', border: `1px solid ${color}`,
                boxShadow: `0 2px 9px rgba(0,0,0,.58), 0 0 8px ${color}55`,
                whiteSpace: 'nowrap',
              }}>
                <div style={{
                  width: 27, height: 27, borderRadius: 8, overflow: 'hidden',
                  display: 'grid', placeItems: 'center', flex: '0 0 auto',
                  background: color, color: '#fff', fontSize: '.72rem', fontWeight: 900,
                  border: `2px solid ${color}`,
                }}>
                  {marker.user.imageUrl
                    ? <img src={marker.user.imageUrl} alt={marker.user.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : marker.user.name.slice(0, 1).toUpperCase()}
                </div>
                {answerTime && <span style={{ color: '#fff', fontSize: '.72rem', fontWeight: 850 }}>{answerTime}</span>}
                {marker.resultLabel && <span style={{ color: '#fff', fontSize: '.72rem', fontWeight: 900 }}>{marker.resultLabel}</span>}
                {marker.firstCorrect && marker.firstCorrectBonus > 0 && (
                  <span style={{ color: '#facc15', fontSize: '.7rem', fontWeight: 900 }}>★ +{marker.firstCorrectBonus}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px 14px',
        marginTop: 12, color: 'var(--text-secondary)', fontSize: '.8rem', fontWeight: 750,
      }}>
        {SPECTRUM_ZONE_MULTIPLIERS.map(multiplier => {
          const color = SPECTRUM_ZONE_COLORS[String(multiplier)];
          const label = formatSpectrumPoints(multiplier, baseScore, question.spectrum_risk_mode || 'risk');
          return (
            <div key={multiplier} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 14, height: 14, borderRadius: 4, display: 'inline-block',
                background: multiplier < 0
                  ? `linear-gradient(rgba(75, 85, 99, 0.48), rgba(75, 85, 99, 0.48)), ${color}`
                  : color,
                border: '1px solid rgba(255,255,255,.16)',
              }} />
              <span>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SpectrumQuestion = ({ question, currentUserId, isAdmin, onlineUsers, onMetaChange }) => {
  const { t } = useTranslation();
  const { gameInfo } = useGame() || {};
  const [state, setState] = useState(emptyState);
  const [clueInput, setClueInput] = useState('');
  const [marker, setMarker] = useState(50);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setState(emptyState);
    setClueInput('');
    setMarker(50);
    const unsubscribe = wsManager.subscribe(message => {
      if (message.type === 'spectrum_state' && Number(message.data?.questionId) === Number(question.id)) {
        setState(message.data);
        if (isAdmin && message.data.hostGuess !== null && Number.isFinite(Number(message.data.hostGuess))) {
          setMarker(Number(message.data.hostGuess));
        } else if (message.data.ownGuess !== null && Number.isFinite(Number(message.data.ownGuess))) {
          setMarker(Number(message.data.ownGuess));
        }
      }
    });
    wsManager.sendSpectrumSync(question.id);
    return unsubscribe;
  }, [question.id, currentUserId, isAdmin]);

  useEffect(() => {
    if (!state.guessingEndsAt || state.phase !== 'guessing') return undefined;
    const updateNow = () => setNow(Math.min(Date.now(), state.guessingEndsAt));
    updateNow();
    const interval = setInterval(() => {
      updateNow();
      if (Date.now() >= state.guessingEndsAt) clearInterval(interval);
    }, 500);
    return () => clearInterval(interval);
  }, [state.guessingEndsAt, state.phase]);

  const clueGiver = onlineUsers.find(user => user.id === state.clueGiverId) || null;
  const selector = onlineUsers.find(user => user.id === state.selectorId) || null;
  const currentPlayer = onlineUsers.find(user => user.id === currentUserId) || null;
  const hostIsPlayer = isAdmin && gameInfo?.mode === 'spectrogram' && !!currentPlayer;
  const hostMarkerOwner = {
    id: '__spectrum_host__',
    name: gameInfo?.hostName || t('spectrum.host'),
    imageUrl: gameInfo?.hostImageUrl || '',
    color: gameInfo?.hostColor || '#f59e0b',
  };
  const markerOwner = hostIsPlayer ? currentPlayer : (isAdmin ? hostMarkerOwner : currentPlayer);
  const markerColor = getPlayerColor(markerOwner || currentUserId);
  const isClueGiver = !!currentUserId && currentUserId === state.clueGiverId;
  const canAssign = isAdmin || (!!currentUserId && currentUserId === state.selectorId);
  const hasSubmitted = hostIsPlayer
    ? state.submittedUserIds.includes(currentUserId)
    : isAdmin ? state.hostSubmitted : state.submittedUserIds.includes(currentUserId);
  const secondsLeft = state.guessingEndsAt ? Math.max(0, Math.ceil((state.guessingEndsAt - now) / 1000)) : null;
  const canGuess = !isClueGiver && state.phase === 'guessing' && (isAdmin || !!currentUserId);
  const isVerbalClue = (state.clueMode || question.spectrum_clue_mode) === 'verbal';
  const autoSubmit = answersNeedNoConfirmation();

  const submitMarker = (position = marker) => {
    const numericPosition = Number(position);
    if (!Number.isFinite(numericPosition)) return;
    if (isAdmin && !hostIsPlayer) {
      wsManager.sendSpectrumHostGuess(question.id, numericPosition);
      return;
    }
    wsManager.sendSpectrumGuess(question.id, numericPosition);
  };

  const result = useMemo(() => {
    if (!state.revealed || !Number.isFinite(Number(state.target))) return null;
    return buildSpectrumScoreSuggestions({
      guesses: state.guesses, clueGiverId: state.clueGiverId, target: Number(state.target),
      range: question.spectrum_range || 20, baseScore: question.price?.correct || 0,
      riskMode: question.spectrum_risk_mode || 'risk',
      guessTimes: state.guessTimes,
      firstCorrectBonus: question.first_place_bonus ?? 100,
      clueGiverCorrectBonus: question.spectrum_clue_bonus ?? 50,
      hostGuess: hostIsPlayer ? null : state.hostGuess,
    });
  }, [state.revealed, state.target, state.guesses, state.guessTimes, state.clueGiverId, state.hostGuess, question, hostIsPlayer]);

  useEffect(() => {
    onMetaChange({
      questionId: question.id,
      clueGiverId: state.clueGiverId,
      answererIds: state.submittedUserIds || [],
      hostSubmitted: state.hostSubmitted,
      suggestions: result?.suggestions || {},
      multipliers: result?.multipliers || {},
      revealed: state.revealed,
    });
  }, [question.id, state.clueGiverId, state.submittedUserIds, state.hostSubmitted, state.revealed, result, onMetaChange]);

  const markers = state.revealed
    ? Object.entries(state.guesses).map(([userId, position]) => ({
        user: onlineUsers.find(user => user.id === userId),
        position: Number(position),
        time: state.guessTimes?.[userId],
        resultLabel: result?.multipliers?.[userId] !== undefined
          ? formatSpectrumPoints(
              result.multipliers[userId],
              question.price?.correct || 0,
              question.spectrum_risk_mode || 'risk'
            )
          : null,
        firstCorrect: result?.firstCorrectUserId === userId,
        firstCorrectBonus: Math.max(0, Number(question.first_place_bonus ?? 100) || 0),
      })).filter(item => item.user && Number.isFinite(item.position))
    : [];
  if (state.revealed && state.hostGuess !== null && !hostIsPlayer) {
    markers.push({
      user: hostMarkerOwner,
      position: Number(state.hostGuess),
      time: state.hostGuessTime,
      resultLabel: result?.hostMultiplier !== null && result?.hostMultiplier !== undefined
        ? formatSpectrumPoints(
            result.hostMultiplier,
            question.price?.correct || 0,
            question.spectrum_risk_mode || 'risk'
          )
        : null,
    });
  }
  const selectableClueGivers = question.allow_self_pick || !state.selectorId
    ? onlineUsers
    : onlineUsers.filter(user => user.id !== state.selectorId);
  const card = {
    width: 'min(100%, 1040px)', margin: '0 auto', padding: 'clamp(1rem, 3vw, 2rem)', borderRadius: 24,
    border: '1px solid var(--glass-border)',
    background: 'linear-gradient(145deg, var(--glass-bg), rgba(10,12,18,.28))',
    boxShadow: 'var(--glass-shadow)', boxSizing: 'border-box',
  };
  const actionButton = (color) => ({
    border: 0, borderRadius: 11, padding: '11px 18px', cursor: 'pointer',
    background: `linear-gradient(rgba(15,23,42,.2), rgba(15,23,42,.2)), ${color}`,
    color: '#fff', font: 'inherit', fontWeight: 800,
    boxShadow: `0 7px 20px ${color}33`,
  });

  if (state.phase === 'assigning') {
    return (
      <div style={card}>
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>🌈 {t('spectrum.title')}</h2>
        {canAssign ? <>
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{t('spectrum.chooseClueGiver')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 14 }}>
            {selectableClueGivers.map(user => (
              <button key={user.id} onClick={() => wsManager.sendSpectrumAssign(question.id, user.id)} style={{ background: `${getPlayerColor(user)}18`, color: 'var(--text-primary)', border: `2px solid ${getPlayerColor(user)}`, borderRadius: 18, padding: 10, cursor: 'pointer', width: 128, boxShadow: `0 8px 22px ${getPlayerColor(user)}22` }}>
                <img src={user.imageUrl} alt={user.name} style={{ width: 84, height: 84, borderRadius: 14, objectFit: 'cover' }} />
                <div style={{ marginTop: 7, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
              </button>
            ))}
          </div>
        </> : <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{selector ? t('spectrum.selectorChoosing', { name: selector.name }) : t('spectrum.waitingForHost')}</p>}
      </div>
    );
  }

  if (state.phase === 'clue') {
    return (
      <div style={card}>
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>🌈 {t('spectrum.title')}</h2>
        <p style={{ textAlign: 'center', color: clueGiver ? getPlayerColor(clueGiver) : 'var(--text-secondary)', fontWeight: 800 }}>{t('spectrum.clueGiverIs', { name: clueGiver?.name || '…' })}</p>
        {isClueGiver && Number.isFinite(Number(state.target)) ? <>
          <SpectrumTrack question={question} target={Number(state.target)} colored showTarget />
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <input value={clueInput} maxLength={300} onChange={event => setClueInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && clueInput.trim()) wsManager.sendSpectrumClue(question.id, clueInput); }} placeholder={t('spectrum.cluePlaceholder')} style={{ flex: 1, minWidth: 0, padding: '13px 16px', borderRadius: 12, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '1rem' }} />
            <button className="btn-primary" disabled={!clueInput.trim()} onClick={() => wsManager.sendSpectrumClue(question.id, clueInput)}>{t('spectrum.sendClue')}</button>
          </div>
        </> : <><SpectrumTrack question={question} /><p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: 0 }}>{t('spectrum.waitingForClue')}</p></>}
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🌈 {t('spectrum.title')}</h2>
        {state.phase === 'guessing' && secondsLeft !== null && <div style={{ fontSize: '1.35rem', fontWeight: 900, color: secondsLeft <= 5 ? 'var(--danger)' : 'var(--text-primary)' }}>⏱ {secondsLeft}</div>}
      </div>
      <div style={{
        margin: '18px 0 22px', padding: '15px 18px', borderRadius: 15,
        background: clueGiver ? `${getPlayerColor(clueGiver)}12` : 'var(--surface-soft)',
        border: `1px solid ${clueGiver ? `${getPlayerColor(clueGiver)}77` : 'var(--glass-border)'}`,
        textAlign: 'center',
      }}>
        <div style={{ color: clueGiver ? getPlayerColor(clueGiver) : 'var(--text-secondary)', fontSize: '.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {t('spectrum.clueGiverIs', { name: clueGiver?.name || '…' })}
        </div>
        {!isVerbalClue && (
          <div style={{ marginTop: 3, fontSize: 'clamp(1.35rem, 4vw, 2.15rem)', fontWeight: 900 }}>{state.clue}</div>
        )}
      </div>
      <SpectrumTrack
        question={question}
        target={state.target}
        colored={state.revealed || isClueGiver}
        showTarget={state.revealed || isClueGiver}
        markers={markers}
        value={canGuess ? marker : null}
        onChange={canGuess ? setMarker : null}
        markerColor={markerColor}
        markerLabel={markerOwner?.name || ''}
        previousValue={hasSubmitted ? (isAdmin && !hostIsPlayer ? state.hostGuess : state.ownGuess) : null}
        onCommit={canGuess && autoSubmit ? submitMarker : null}
      />
      {state.phase === 'guessing' && <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexWrap: 'wrap', gap: 10, marginTop: 16,
      }}>
        {canGuess && !autoSubmit && (
          <button style={actionButton(markerColor)} onClick={() => submitMarker()}>
            {hasSubmitted ? t('spectrum.updateMarker') : t('spectrum.lockMarker')}
          </button>
        )}
        {(isAdmin || isClueGiver) && <div style={{
          padding: '9px 13px', borderRadius: 10, background: 'var(--surface-soft)',
          border: '1px solid var(--glass-border)', color: 'var(--text-secondary)', fontWeight: 750,
        }}>{t('spectrum.answersCount', { count: state.submittedUserIds.length + (!hostIsPlayer && state.hostSubmitted ? 1 : 0) })}</div>}
        {isAdmin && <button className="btn-primary" style={{ margin: 0 }} onClick={() => wsManager.sendSpectrumReveal(question.id)}>{t('spectrum.reveal')}</button>}
      </div>}
      {isAdmin && !hostIsPlayer && state.phase === 'guessing' && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '.8rem', marginBottom: 0 }}>{t('spectrum.hostGuessHint')}</p>}
      {isClueGiver && state.phase === 'guessing' && <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{t('spectrum.clueGiverWait')}</p>}
    </div>
  );
};

export default SpectrumQuestion;
