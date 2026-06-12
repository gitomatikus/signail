import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import wsManager from '../utils/websocket';
import {
  startSingerPipeline,
  createListenerPlayer,
  isKaraokeStreamingSupported,
  parseLrc,
  hasLrcTimestamps,
  currentLrcIndex,
  dataUrlToObjectUrl,
  isVideoMedia
} from '../utils/karaoke';
import { useTranslation } from '../i18n/LanguageContext';

// First stamped word in `line` at or after `fromIdx`, else `fallback` -
// a word's fill ends where the next stamped word begins
const nextTimedStart = (line, fromIdx, fallback) => {
  for (let j = fromIdx; j < line.words.length; j++) {
    if (line.words[j].timeMs !== null) return line.words[j].timeMs;
  }
  return fallback;
};

const renderKaraokeWord = (line, word, wi, nowMs, nextLineTimeMs) => {
  const fallbackEnd = nextLineTimeMs !== null && nextLineTimeMs > line.timeMs
    ? nextLineTimeMs
    : (word.timeMs ?? line.timeMs) + 1000;
  let progress;
  if (word.timeMs !== null) {
    const startMs = word.timeMs;
    // An explicit A2 end tag gives the word its own sweep length;
    // otherwise it fills until the next stamped word begins
    const endMs = word.endMs !== null && word.endMs !== undefined
      ? Math.max(startMs + 40, word.endMs)
      : Math.max(startMs + 120, nextTimedStart(line, wi + 1, fallbackEnd));
    progress = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));
  } else {
    // Unstamped words light up when the next stamped word is reached
    progress = nowMs >= nextTimedStart(line, wi + 1, fallbackEnd) ? 1 : 0;
  }
  const style = {};
  if (progress >= 1) {
    style.color = 'var(--accent)';
    style.textShadow = '0 0 18px var(--accent-glow)';
  } else if (progress <= 0) {
    style.color = 'var(--text-secondary)';
    style.opacity = 0.85;
  } else {
    const pct = (progress * 100).toFixed(1);
    style.backgroundImage = `linear-gradient(90deg, var(--accent) ${pct}%, var(--text-secondary) ${pct}%)`;
    style.WebkitBackgroundClip = 'text';
    style.backgroundClip = 'text';
    style.WebkitTextFillColor = 'transparent';
    style.color = 'transparent';
    style.filter = 'drop-shadow(0 0 10px var(--accent-glow))';
  }
  return <span key={wi} style={style}>{word.text}</span>;
};

// Timed lyrics display. Runs its own rAF clock (smoothed against the chunky
// 250ms track time of the listener stream) so the per-word karaoke fill of
// enhanced-LRC lines sweeps smoothly; line-level LRC keeps the old behavior.
const KaraokeLyrics = ({ lines, getTimeMs }) => {
  const [nowMs, setNowMs] = useState(null);

  useEffect(() => {
    let raf;
    let est = null;
    let lastWall = performance.now();
    const tick = () => {
      const wall = performance.now();
      const dt = wall - lastWall;
      lastWall = wall;
      const raw = getTimeMs();
      if (raw === null || raw === undefined) {
        est = null;
      } else if (est === null || raw < est - 600) {
        est = raw; // first sample, seek or restart
      } else {
        // Advance on the wall clock, snap up to fresher samples, and freeze
        // at most 450ms past the last sample (chunk cadence is 250ms)
        est = Math.min(Math.max(est + dt, raw), raw + 450);
      }
      // Quantized so React re-renders ~25fps instead of every frame
      setNowMs(est === null ? null : Math.round(est / 40) * 40);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getTimeMs]);

  const idx = currentLrcIndex(lines, nowMs ?? -1);
  const start = Math.max(0, Math.min(idx - 2, lines.length - 7));
  const visible = lines.slice(start, start + 7);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', width: '100%', maxWidth: '760px', minHeight: '13rem', justifyContent: 'center' }}>
      {visible.map((line, i) => {
        const globalIdx = start + i;
        const isCurrent = globalIdx === idx;
        const lineStyle = {
          fontSize: isCurrent ? '1.7rem' : '1.15rem',
          fontWeight: isCurrent ? '800' : '500',
          color: isCurrent ? 'var(--accent)' : 'var(--text-secondary)',
          opacity: isCurrent ? 1 : 0.75,
          textShadow: isCurrent ? '0 0 18px var(--accent-glow)' : 'none',
          transition: 'all 0.25s',
          textAlign: 'center'
        };
        if (!isCurrent || !line.words || nowMs === null) {
          return (
            <div key={`${line.timeMs}-${globalIdx}`} style={lineStyle}>
              {line.text || '♪'}
            </div>
          );
        }
        const nextLineTimeMs = globalIdx + 1 < lines.length ? lines[globalIdx + 1].timeMs : null;
        return (
          <div
            key={`${line.timeMs}-${globalIdx}`}
            style={{
              ...lineStyle,
              textShadow: 'none',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              columnGap: '0.45em',
              rowGap: '0.1em'
            }}
          >
            {line.words.map((word, wi) => renderKaraokeWord(line, word, wi, nowMs, nextLineTimeMs))}
          </div>
        );
      })}
    </div>
  );
};

// One karaoke performance: the assigned singer plays the track locally, the
// browser mixes it with their microphone and streams the mix in chunks over
// the websocket; everyone else plays that stream. Lyrics (and the local muted
// video copy, when the media is a video) follow the audio each client hears.
const KaraokeQuestion = ({
  question,
  isAdmin,
  currentUserId,
  onlineUsers,
  isQuestionRevealed,
  targetId,
  selectorId,
  volume,
  cardStyle,
  themeHeaderStyle
}) => {
  const { t } = useTranslation();
  const questionId = question.id;

  // { id, durationMs, ended } - the latest performance announced for this question
  const [performance, setPerformance] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false); // singer: my pipeline is live
  const [micActive, setMicActive] = useState(true);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [error, setError] = useState(null);

  const isSinger = !!currentUserId && currentUserId === targetId;

  const singerMediaRef = useRef(null);
  const listenerAudioRef = useRef(null);
  const listenerVideoRef = useRef(null);
  const pipelineRef = useRef(null);
  const playerRef = useRef(null); // { perfId, player }
  const perfIdRef = useRef(null); // performance id of MY active pipeline (singer)
  const pendingChunksRef = useRef(new Map()); // perfId -> chunks before the player exists
  const volumeRef = useRef(volume);

  // Created in an effect (not useMemo) so a StrictMode remount mints a fresh
  // Blob URL after the cleanup revoked the previous one
  const [mediaUrl, setMediaUrl] = useState(null);
  useEffect(() => {
    const url = dataUrlToObjectUrl(question.media);
    setMediaUrl(url);
    return () => {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [question.media]);
  const mediaIsVideo = isVideoMedia(question.media);

  const lrcLines = useMemo(() => {
    if (!question.lyrics) return [];
    if (question.lyrics_format === 'plain') return [];
    if (question.lyrics_format === 'lrc' || hasLrcTimestamps(question.lyrics)) {
      return parseLrc(question.lyrics);
    }
    return [];
  }, [question.lyrics, question.lyrics_format]);

  // ---------- lifecycle ----------

  const destroyListenerPlayer = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.player.destroy();
      playerRef.current = null;
    }
  }, []);

  const stopPipeline = useCallback(() => {
    if (pipelineRef.current) {
      pipelineRef.current.stop();
      pipelineRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  // Everything down on unmount / question change
  useEffect(() => () => {
    stopPipeline();
    destroyListenerPlayer();
  }, [questionId, stopPipeline, destroyListenerPlayer]);

  // The page volume slider drives the singer's private monitor loudness
  // (their media element itself is pinned to 1 - it feeds the recording)
  useEffect(() => {
    volumeRef.current = volume;
    if (pipelineRef.current) {
      pipelineRef.current.setMonitorVolume(volume);
    }
  }, [volume]);

  // Listeners attach an MSE player to the hidden audio element as soon as a
  // performance is announced; chunks that raced ahead are flushed from the stash
  useEffect(() => {
    if (isSinger || !performance || !listenerAudioRef.current) return;
    if (playerRef.current && playerRef.current.perfId === performance.id) return;
    destroyListenerPlayer();
    setAutoplayBlocked(false);
    const player = createListenerPlayer({
      audioEl: listenerAudioRef.current,
      onAutoplayBlocked: () => setAutoplayBlocked(true)
    });
    playerRef.current = { perfId: performance.id, player };
    const stashed = pendingChunksRef.current.get(performance.id) || [];
    pendingChunksRef.current.delete(performance.id);
    stashed.forEach((chunk) => player.push(chunk));
    if (performance.ended) {
      player.finalize();
    }
  }, [performance, isSinger, destroyListenerPlayer]);

  // ---------- websocket ----------

  useEffect(() => {
    wsManager.sendKaraokeSync(questionId);
    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'ws_open') {
        // Reconnected mid-performance: the backlog fills the gap (the player
        // dedups by seq), live relay resumes on the new socket
        wsManager.sendKaraokeSync(questionId);
        return;
      }
      if (!data.data || data.data.questionId !== questionId) return;

      if (data.type === 'karaoke_state') {
        if (data.data.performance) {
          setPerformance(data.data.performance);
        }
      } else if (data.type === 'karaoke_start') {
        const { performanceId, durationMs } = data.data;
        setPerformance({ id: performanceId, durationMs, ended: false });
        setError(null);
      } else if (data.type === 'karaoke_chunk') {
        const { performanceId, seq, t: chunkT, b64 } = data.data;
        const chunk = { seq, t: chunkT, b64 };
        const active = playerRef.current;
        if (active && active.perfId === performanceId) {
          active.player.push(chunk);
        } else {
          // Player not built yet (state message still in flight) - stash
          const stash = pendingChunksRef.current.get(performanceId) || [];
          if (stash.length < 4000) {
            stash.push(chunk);
            pendingChunksRef.current.set(performanceId, stash);
          }
        }
      } else if (data.type === 'karaoke_end') {
        const { performanceId } = data.data;
        setPerformance(prev => (prev && prev.id === performanceId ? { ...prev, ended: true } : prev));
        if (playerRef.current && playerRef.current.perfId === performanceId) {
          playerRef.current.player.finalize();
        }
        // The host may cut a performance short - stop my pipeline too
        if (perfIdRef.current === performanceId) {
          stopPipeline();
          const el = singerMediaRef.current;
          if (el && !el.paused) el.pause();
        }
      }
    });
    return unsubscribe;
  }, [questionId, stopPipeline]);

  // ---------- track clock (lyrics + video sync) ----------

  // KaraokeLyrics polls these every frame; refs keep their identity stable
  const getSingerTimeMs = useCallback(() => {
    const el = singerMediaRef.current;
    return el ? el.currentTime * 1000 : null;
  }, []);
  const getListenerTimeMs = useCallback(() => {
    const active = playerRef.current;
    return active ? active.player.getTrackTimeMs() : null;
  }, []);

  // Listeners watch their own local copy of the video, muted, nudged to the
  // audio they are hearing - eyes tolerate the small drift, ears would not
  useEffect(() => {
    if (isSinger || !mediaIsVideo) return;
    const interval = setInterval(() => {
      const videoEl = listenerVideoRef.current;
      const active = playerRef.current;
      if (!videoEl || !active) return;
      const tMs = active.player.getTrackTimeMs();
      if (tMs === null) return;
      const live = performance && !performance.ended;
      if (live && videoEl.paused) {
        videoEl.play().catch(() => {});
      } else if (!live && !videoEl.paused) {
        videoEl.pause();
      }
      if (Math.abs(videoEl.currentTime * 1000 - tMs) > 400) {
        videoEl.currentTime = tMs / 1000;
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isSinger, mediaIsVideo, performance]);

  // ---------- singer actions ----------

  const finishPerformance = useCallback(() => {
    const performanceId = perfIdRef.current;
    if (!performanceId) return;
    stopPipeline();
    // The recorder's final chunk is converted+sent async; give it a moment
    // before karaoke_end makes the server drop further chunks
    setTimeout(() => wsManager.sendKaraokeEnd(questionId, performanceId), 800);
  }, [questionId, stopPipeline]);

  useEffect(() => {
    const el = singerMediaRef.current;
    if (!el || !isSinger) return;
    const onEnded = () => finishPerformance();
    el.addEventListener('ended', onEnded);
    return () => el.removeEventListener('ended', onEnded);
  }, [isSinger, finishPerformance, mediaUrl]);

  const handleStart = async () => {
    const mediaEl = singerMediaRef.current;
    if (!mediaEl || !currentUserId) return;
    setError(null);
    if (!isKaraokeStreamingSupported()) {
      setError(t('question.karaokeUnsupported'));
      return;
    }
    try {
      // Metadata gives the duration everyone's countdown uses
      if (!Number.isFinite(mediaEl.duration) || mediaEl.duration === 0) {
        await new Promise((resolve) => {
          const done = () => { mediaEl.removeEventListener('loadedmetadata', done); resolve(); };
          mediaEl.addEventListener('loadedmetadata', done);
          setTimeout(done, 3000);
        });
      }
      const durationMs = Number.isFinite(mediaEl.duration)
        ? Math.round(mediaEl.duration * 1000)
        : null;
      const performanceId = `${currentUserId}-${Date.now()}`;

      stopPipeline(); // restart replaces any previous attempt
      const pipeline = await startSingerPipeline({
        mediaEl,
        monitorVolume: volumeRef.current,
        onChunk: (chunk) => wsManager.sendKaraokeChunk(questionId, performanceId, chunk)
      });
      perfIdRef.current = performanceId;
      pipelineRef.current = pipeline;
      setMicActive(pipeline.micActive);
      wsManager.sendKaraokeStart(questionId, performanceId, durationMs);
      mediaEl.currentTime = 0;
      await mediaEl.play();
      setIsStreaming(true);
    } catch (e) {
      console.error('Karaoke: failed to start performance', e);
      stopPipeline();
      setError(e && e.message === 'karaoke-unsupported'
        ? t('question.karaokeUnsupported')
        : t('question.karaokeStartFailed'));
    }
  };

  const handleHostEnd = () => {
    if (performance && !performance.ended) {
      wsManager.sendKaraokeEnd(questionId, performance.id);
    }
  };

  // ---------- assignment ----------

  const handleAssign = (userId) => {
    wsManager.sendKaraokeAssign(questionId, userId, selectorId);
  };

  const targetUser = onlineUsers.find(u => u.id === targetId);
  const selectorUser = onlineUsers.find(u => u.id === selectorId);
  // The selector picks the singer (themselves included); the admin can always assign
  const canAssign = isAdmin || (!!currentUserId && currentUserId === selectorId);

  // ---------- render helpers ----------

  const renderAvatar = (u) => (
    u.imageUrl && u.imageUrl.toLowerCase().endsWith('.mp4') ? (
      <video src={u.imageUrl} style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }} autoPlay loop muted playsInline />
    ) : (
      <img src={u.imageUrl} alt={u.name} style={{ width: '64px', height: '64px', borderRadius: '16px', objectFit: 'cover' }} />
    )
  );

  const renderLyrics = () => {
    if (!question.lyrics) return null;
    if (lrcLines.length > 0) {
      return (
        <KaraokeLyrics
          lines={lrcLines}
          getTimeMs={isSinger ? getSingerTimeMs : getListenerTimeMs}
        />
      );
    }
    return (
      <div style={{
        whiteSpace: 'pre-wrap',
        fontSize: '1.2rem',
        lineHeight: 1.7,
        color: 'var(--text-primary)',
        maxHeight: '45vh',
        overflowY: 'auto',
        width: '100%',
        maxWidth: '760px',
        textAlign: 'center'
      }}>
        {question.lyrics}
      </div>
    );
  };

  const noticeStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    fontSize: '1.05rem',
    color: 'var(--text-secondary)',
    textAlign: 'left'
  };

  // ---------- views ----------

  if (!targetId) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: '4rem', marginBottom: '0.5rem' }}>🎤</div>
        <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--accent)', marginBottom: '1rem', textShadow: '0 0 20px var(--accent-glow)' }}>
          {t('question.karaokeTitle')}
        </div>
        <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          {canAssign
            ? t('question.karaokeChooseSinger')
            : selectorUser
              ? t('question.selectorChoosing', { name: selectorUser.name })
              : t('question.waitingChoice')}
        </div>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {onlineUsers.map(u => (
            <div
              key={u.id}
              onClick={canAssign ? () => handleAssign(u.id) : undefined}
              style={{
                cursor: canAssign ? 'pointer' : 'default',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.75rem',
                borderRadius: '12px',
                border: '1px solid var(--glass-border)',
                background: 'var(--bg-dark)',
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
              {renderAvatar(u)}
              <span style={{ fontSize: '1rem', fontWeight: '600', textAlign: 'center', wordBreak: 'break-word' }}>
                {u.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const live = !!performance && !performance.ended;
  const done = !!performance && performance.ended;

  const header = (
    <div style={{ ...themeHeaderStyle, color: 'var(--accent)', textShadow: '0 0 20px var(--accent-glow)' }}>
      {t('question.karaokeSinging', { name: targetUser ? targetUser.name : '...' })}
    </div>
  );

  // --- singer ---
  if (isSinger) {
    const waitingForReveal = !isQuestionRevealed;
    const showStart = isQuestionRevealed && (!live || !isStreaming) && !done;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {header}
        <div style={cardStyle}>
          {/* The media element always exists for the singer: the pipeline
              attaches to it. Video is visible; audio stays headless. */}
          {mediaIsVideo ? (
            <video
              ref={singerMediaRef}
              src={mediaUrl}
              preload="auto"
              playsInline
              style={{ maxWidth: '100%', maxHeight: '45vh', borderRadius: '12px', display: isStreaming || done ? 'block' : 'none' }}
            />
          ) : (
            <audio ref={singerMediaRef} src={mediaUrl} preload="auto" style={{ display: 'none' }} />
          )}

          {waitingForReveal && (
            <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
              {t('question.waitingReveal')}
            </div>
          )}

          {showStart && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', maxWidth: '620px' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: '800', color: 'var(--text-primary)' }}>
                {t('question.karaokeYourTurn')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <div style={noticeStyle}><span>🎧</span><span>{t('question.karaokeHeadphones')}</span></div>
                <div style={noticeStyle}><span>🔇</span><span>{t('question.karaokeMuteDiscord')}</span></div>
                <div style={noticeStyle}><span>🎙️</span><span>{t('question.karaokeMicAsk')}</span></div>
              </div>
              <button className="btn-primary" style={{ padding: '0.9rem 2.5rem', fontSize: '1.15rem' }} onClick={handleStart}>
                {live ? t('question.karaokeRestart') : t('question.karaokeStart')}
              </button>
              {error && <div style={{ color: '#ef4444', fontSize: '1rem' }}>{error}</div>}
            </div>
          )}

          {isStreaming && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', width: '100%' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                color: '#ef4444', fontWeight: '700', fontSize: '1rem', letterSpacing: '0.08em', textTransform: 'uppercase'
              }}>
                <span className="karaoke-live-dot" style={{
                  width: '10px', height: '10px', borderRadius: '50%', background: '#ef4444',
                  display: 'inline-block', animation: 'karaokePulse 1.2s ease-in-out infinite'
                }} />
                {t('question.karaokeOnAir')}
                <style>{'@keyframes karaokePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'}</style>
              </div>
              {!micActive && (
                <div style={{ color: '#fbbf24', fontSize: '1rem' }}>
                  {t('question.karaokeMicMissing')}
                </div>
              )}
              {renderLyrics()}
            </div>
          )}

          {done && !isStreaming && (
            <div style={{ fontSize: '1.3rem', color: 'var(--text-secondary)' }}>
              {t('question.karaokeDone')}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- listener (players and host) ---
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {header}
      <div style={cardStyle}>
        <audio ref={listenerAudioRef} style={{ display: 'none' }} />

        {!performance && (
          <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
            {t('question.karaokeWaitingStart', { name: targetUser ? targetUser.name : '...' })}
          </div>
        )}

        {performance && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center', width: '100%' }}>
            {mediaIsVideo && (
              <video
                ref={listenerVideoRef}
                src={mediaUrl}
                muted
                playsInline
                preload="auto"
                style={{ maxWidth: '100%', maxHeight: '45vh', borderRadius: '12px' }}
              />
            )}
            {autoplayBlocked && live && (
              <button
                className="btn-primary"
                style={{ padding: '0.75rem 2rem', fontSize: '1.1rem' }}
                onClick={() => {
                  setAutoplayBlocked(false);
                  if (playerRef.current) playerRef.current.player.resume();
                }}
              >
                {t('question.karaokeClickToListen')}
              </button>
            )}
            {live ? renderLyrics() : (
              <div style={{ fontSize: '1.3rem', color: 'var(--text-secondary)' }}>
                {t('question.karaokeDone')}
              </div>
            )}
            {isAdmin && live && (
              <button className="btn-danger" style={{ padding: '0.6rem 1.5rem', fontSize: '1rem' }} onClick={handleHostEnd}>
                {t('question.karaokeEndPerformance')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default KaraokeQuestion;
