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
  isVideoMedia,
  runMicCheck,
  getVoiceSyncCalibration,
  setVoiceSyncOverride,
  clearVoiceSyncOverride,
  createKaraokeRecordingBlob,
  createMicCheckPreview,
  VOICE_SYNC_CHANGE_EVENT
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

const formatDuration = (milliseconds) => {
  const totalSeconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const MicCheckTimeline = ({
  waveform,
  beatCount,
  intervalMs,
  durationMs,
  playheadMs,
  label
}) => {
  const width = 1000;
  const height = 150;
  const centerY = 78;
  const waveformHeight = 54;
  const barWidth = width / Math.max(1, waveform.length);
  return (
    <div style={{
      width: '100%',
      padding: '0.55rem',
      borderRadius: '10px',
      background: 'rgba(0, 0, 0, 0.2)',
      border: '1px solid var(--glass-border)'
    }}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ display: 'block', width: '100%', height: '130px' }}
      >
        <line
          x1="0"
          x2={width}
          y1={centerY}
          y2={centerY}
          stroke="var(--glass-border)"
          strokeWidth="2"
        />
        {waveform.map((amplitude, index) => {
          const barHeight = Math.max(2, amplitude * waveformHeight);
          return (
            <rect
              key={index}
              x={index * barWidth}
              y={centerY - barHeight / 2}
              width={Math.max(1, barWidth * 0.72)}
              height={barHeight}
              rx="1"
              fill="var(--accent)"
              opacity="0.78"
            />
          );
        })}
        {Array.from({ length: beatCount }, (_, index) => {
          const x = durationMs > 0 ? index * intervalMs / durationMs * width : 0;
          return (
            <g key={index}>
              <line
                x1={x}
                x2={x}
                y1="12"
                y2={height - 12}
                stroke="var(--accent)"
                strokeWidth="5"
                opacity="0.92"
              />
              <circle cx={x} cy="12" r="7" fill="var(--accent)" />
            </g>
          );
        })}
        {playheadMs !== null && (
          <line
            x1={Math.min(width, Math.max(0, playheadMs / durationMs * width))}
            x2={Math.min(width, Math.max(0, playheadMs / durationMs * width))}
            y1="0"
            y2={height}
            stroke="#ffffff"
            strokeWidth="3"
            opacity="0.9"
          />
        )}
      </svg>
    </div>
  );
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
  const [micCheckStatus, setMicCheckStatus] = useState('idle');
  const [micCheckBeat, setMicCheckBeat] = useState(null);
  const [micCheckProgress, setMicCheckProgress] = useState({ detected: 0, total: 8, estimateMs: null });
  const [micCheckError, setMicCheckError] = useState(null);
  const [micCheckRecording, setMicCheckRecording] = useState(null);
  const [micCheckPreviewReady, setMicCheckPreviewReady] = useState(false);
  const [micCheckPreviewPlaying, setMicCheckPreviewPlaying] = useState(false);
  const [micCheckWaveform, setMicCheckWaveform] = useState([]);
  const [micCheckPlayheadMs, setMicCheckPlayheadMs] = useState(0);
  const [calibration, setCalibration] = useState(() => getVoiceSyncCalibration());
  const [nudgeMs, setNudgeMs] = useState(() =>
    calibration ? calibration.latencyMs - calibration.measuredLatencyMs : 0
  );
  const [hostRecording, setHostRecording] = useState({
    status: 'idle',
    performanceId: null,
    elapsedMs: 0,
    durationMs: null,
    bytes: 0,
    url: null
  });

  const isSinger = !!currentUserId && currentUserId === targetId;

  const singerMediaRef = useRef(null);
  const listenerAudioRef = useRef(null);
  const recordingAudioRef = useRef(null);
  const listenerVideoRef = useRef(null);
  const pipelineRef = useRef(null);
  const playerRef = useRef(null); // { perfId, player }
  const perfIdRef = useRef(null); // performance id of MY active pipeline (singer)
  const micCheckAbortRef = useRef(null);
  const micCheckPreviewRef = useRef(null);
  const micCheckPlayheadRafRef = useRef(null);
  const calibrationRef = useRef(calibration);
  const pendingChunksRef = useRef(new Map()); // perfId -> chunks before the player exists
  const hostRecordingChunksRef = useRef(new Map());
  const hostRecordingPerfRef = useRef(null);
  const hostRecordingDurationRef = useRef(null);
  const hostRecordingUrlRef = useRef(null);
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

  const beginHostRecording = useCallback((performanceId, durationMs) => {
    if (!isAdmin) return;
    if (hostRecordingUrlRef.current) {
      URL.revokeObjectURL(hostRecordingUrlRef.current);
      hostRecordingUrlRef.current = null;
    }
    hostRecordingChunksRef.current.clear();
    hostRecordingPerfRef.current = performanceId;
    hostRecordingDurationRef.current = durationMs;
    setHostRecording({
      status: 'recording',
      performanceId,
      elapsedMs: 0,
      durationMs,
      bytes: 0,
      url: null
    });
  }, [isAdmin]);

  const captureHostRecordingChunk = useCallback((performanceId, chunk) => {
    if (!isAdmin || !chunk || hostRecordingPerfRef.current !== performanceId) return;
    const chunks = hostRecordingChunksRef.current;
    if (chunks.has(chunk.seq)) return;
    chunks.set(chunk.seq, chunk);
    const chunkBytes = Math.floor((chunk.b64.length * 3) / 4);
    setHostRecording(prev => ({
      status: 'recording',
      performanceId,
      elapsedMs: Math.max(prev.performanceId === performanceId ? prev.elapsedMs : 0, chunk.t || 0),
      durationMs: prev.performanceId === performanceId
        ? prev.durationMs
        : hostRecordingDurationRef.current,
      bytes: (prev.performanceId === performanceId ? prev.bytes : 0) + chunkBytes,
      url: null
    }));
  }, [isAdmin]);

  const finishHostRecording = useCallback((performanceId) => {
    if (!isAdmin || hostRecordingPerfRef.current !== performanceId) return;
    const blob = createKaraokeRecordingBlob([...hostRecordingChunksRef.current.values()]);
    if (blob.size === 0) {
      setHostRecording(prev => ({ ...prev, status: 'empty' }));
      return;
    }
    if (hostRecordingUrlRef.current) URL.revokeObjectURL(hostRecordingUrlRef.current);
    const url = URL.createObjectURL(blob);
    hostRecordingUrlRef.current = url;
    setHostRecording(prev => ({
      ...prev,
      status: 'ready',
      elapsedMs: prev.durationMs || prev.elapsedMs,
      bytes: blob.size,
      url
    }));
  }, [isAdmin]);

  // Everything down on unmount / question change
  useEffect(() => () => {
    if (micCheckAbortRef.current) micCheckAbortRef.current.abort();
    if (micCheckPreviewRef.current) micCheckPreviewRef.current.destroy();
    if (micCheckPlayheadRafRef.current) cancelAnimationFrame(micCheckPlayheadRafRef.current);
    if (hostRecordingUrlRef.current) URL.revokeObjectURL(hostRecordingUrlRef.current);
    stopPipeline();
    destroyListenerPlayer();
  }, [questionId, stopPipeline, destroyListenerPlayer]);

  useEffect(() => {
    calibrationRef.current = calibration;
  }, [calibration]);

  useEffect(() => {
    const syncCalibration = () => {
      const saved = getVoiceSyncCalibration();
      setCalibration(saved);
      setNudgeMs(saved ? saved.latencyMs - saved.measuredLatencyMs : 0);
      if (micCheckPreviewRef.current && saved) {
        micCheckPreviewRef.current.setVoiceSyncMs(saved.latencyMs);
        setMicCheckWaveform(micCheckPreviewRef.current.getWaveform());
      }
    };
    window.addEventListener(VOICE_SYNC_CHANGE_EVENT, syncCalibration);
    return () => window.removeEventListener(VOICE_SYNC_CHANGE_EVENT, syncCalibration);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (micCheckPreviewRef.current) {
      micCheckPreviewRef.current.destroy();
      micCheckPreviewRef.current = null;
    }
    setMicCheckPreviewReady(false);
    setMicCheckPreviewPlaying(false);
    setMicCheckWaveform([]);
    setMicCheckPlayheadMs(0);
    if (!micCheckRecording) return undefined;
    createMicCheckPreview({
      ...micCheckRecording.preview,
      recordingBlob: micCheckRecording.blob,
      voiceSyncMs: calibrationRef.current ? calibrationRef.current.latencyMs : 0,
      volume: volumeRef.current,
      onEnded: () => {
        setMicCheckPreviewPlaying(false);
        setMicCheckPlayheadMs(0);
      }
    }).then((preview) => {
      if (cancelled) {
        if (preview) preview.destroy();
        return;
      }
      micCheckPreviewRef.current = preview;
      setMicCheckPreviewReady(!!preview);
      setMicCheckWaveform(preview ? preview.getWaveform() : []);
    }).catch((previewError) => {
      console.warn('Karaoke: mic check preview unavailable', previewError);
    });
    return () => {
      cancelled = true;
      if (micCheckPreviewRef.current) {
        micCheckPreviewRef.current.destroy();
        micCheckPreviewRef.current = null;
      }
    };
  }, [micCheckRecording]);

  useEffect(() => {
    if (!micCheckPreviewPlaying) return undefined;
    const updatePlayhead = () => {
      const preview = micCheckPreviewRef.current;
      if (!preview || !preview.isPlaying()) {
        setMicCheckPreviewPlaying(false);
        return;
      }
      setMicCheckPlayheadMs(preview.getPositionMs());
      micCheckPlayheadRafRef.current = requestAnimationFrame(updatePlayhead);
    };
    micCheckPlayheadRafRef.current = requestAnimationFrame(updatePlayhead);
    return () => {
      if (micCheckPlayheadRafRef.current) {
        cancelAnimationFrame(micCheckPlayheadRafRef.current);
        micCheckPlayheadRafRef.current = null;
      }
    };
  }, [micCheckPreviewPlaying]);

  // The page volume slider drives the singer's private monitor loudness
  // (their media element itself is pinned to 1 - it feeds the recording)
  useEffect(() => {
    volumeRef.current = volume;
    if (pipelineRef.current) {
      pipelineRef.current.setMonitorVolume(volume);
    }
    if (micCheckPreviewRef.current) {
      micCheckPreviewRef.current.setVolume(volume);
    }
    [listenerAudioRef.current, recordingAudioRef.current].forEach((el) => {
      if (!el) return;
      el.__programmaticChange = true;
      el.volume = Math.min(1, Math.max(0, volume));
      el.__programmaticChange = false;
    });
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
          if (isAdmin && hostRecordingPerfRef.current !== data.data.performance.id) {
            const syncedPerformance = data.data.performance;
            beginHostRecording(syncedPerformance.id, syncedPerformance.durationMs);
            if (syncedPerformance.ended) {
              setHostRecording(prev => ({ ...prev, status: 'empty' }));
            }
          }
        }
      } else if (data.type === 'karaoke_start') {
        const { performanceId, durationMs } = data.data;
        setPerformance({ id: performanceId, durationMs, ended: false });
        setError(null);
        beginHostRecording(performanceId, durationMs);
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
        captureHostRecordingChunk(performanceId, chunk);
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
        finishHostRecording(performanceId);
      }
    });
    return unsubscribe;
  }, [
    questionId,
    stopPipeline,
    isAdmin,
    beginHostRecording,
    captureHostRecordingChunk,
    finishHostRecording
  ]);

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
    const pipeline = pipelineRef.current;
    // The mix runs voiceSyncMs behind the element clock, so at 'ended' the
    // last stretch of the song (and the final sung note) is still inside the
    // delay line - keep recording until it drains. The recorder's final chunk
    // is then converted+sent async; give it a moment before karaoke_end makes
    // the server drop further chunks.
    const drainMs = (pipeline && pipeline.voiceSyncMs ? pipeline.voiceSyncMs : 0) + 300;
    setTimeout(() => {
      if (pipelineRef.current === pipeline) {
        stopPipeline();
      }
      setTimeout(() => wsManager.sendKaraokeEnd(questionId, performanceId), 800);
    }, drainMs);
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
      beginHostRecording(performanceId, durationMs);
      const pipeline = await startSingerPipeline({
        mediaEl,
        monitorVolume: volumeRef.current,
        onChunk: (chunk) => {
          captureHostRecordingChunk(performanceId, chunk);
          wsManager.sendKaraokeChunk(questionId, performanceId, chunk);
        }
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

  const handleMicCheck = async () => {
    const mediaEl = singerMediaRef.current;
    if (!mediaEl) return;
    if (micCheckAbortRef.current) micCheckAbortRef.current.abort();
    const controller = new AbortController();
    micCheckAbortRef.current = controller;
    setMicCheckStatus('running');
    setMicCheckBeat({ phase: 'ready', index: 0, total: 4 });
    setMicCheckProgress({ detected: 0, total: 8, estimateMs: null });
    setMicCheckError(null);
    if (micCheckPreviewRef.current) {
      micCheckPreviewRef.current.destroy();
      micCheckPreviewRef.current = null;
      setMicCheckPreviewReady(false);
      setMicCheckPreviewPlaying(false);
    }
    setMicCheckRecording(null);
    try {
      const result = await runMicCheck({
        mediaEl,
        signal: controller.signal,
        onBeat: beat => setMicCheckBeat(beat),
        onProgress: progress => setMicCheckProgress(progress)
      });
      const latencyMs = setVoiceSyncOverride(result.latencyMs, {
        measuredLatencyMs: result.latencyMs,
        source: 'mic-check',
        confidence: result.confidence
      });
      setCalibration({
        latencyMs,
        measuredLatencyMs: result.latencyMs,
        calibratedAt: new Date().toISOString(),
        source: 'mic-check',
        confidence: result.confidence
      });
      setNudgeMs(0);
      if (result.recordingBlob && result.recordingBlob.size > 0 && result.preview) {
        setMicCheckRecording({
          blob: result.recordingBlob,
          preview: result.preview
        });
      }
      setMicCheckStatus('done');
      setMicCheckBeat(null);
    } catch (e) {
      if (e && e.code === 'aborted') return;
      setMicCheckStatus('error');
      setMicCheckBeat(null);
      setMicCheckError(e && e.code ? e.code : 'mic-denied');
    } finally {
      if (micCheckAbortRef.current === controller) {
        micCheckAbortRef.current = null;
      }
    }
  };

  const handleNudge = (value) => {
    const nextNudge = Number(value);
    const measuredLatencyMs = calibration ? calibration.measuredLatencyMs : 0;
    const latencyMs = setVoiceSyncOverride(measuredLatencyMs + nextNudge, {
      measuredLatencyMs,
      source: 'mic-check',
      confidence: calibration ? calibration.confidence : undefined
    });
    setNudgeMs(latencyMs - measuredLatencyMs);
    setCalibration(prev => ({ ...prev, latencyMs }));
    if (micCheckPreviewRef.current) {
      micCheckPreviewRef.current.setVoiceSyncMs(latencyMs);
      setMicCheckWaveform(micCheckPreviewRef.current.getWaveform());
    }
  };

  const handleResetCalibration = () => {
    clearVoiceSyncOverride();
    setCalibration(null);
    setNudgeMs(0);
    setMicCheckStatus('idle');
    setMicCheckError(null);
    setMicCheckRecording(null);
  };

  const handleMicCheckPreview = async () => {
    const preview = micCheckPreviewRef.current;
    if (!preview) return;
    if (preview.isPlaying()) {
      preview.stop();
      setMicCheckPreviewPlaying(false);
      setMicCheckPlayheadMs(preview.getPositionMs());
      return;
    }
    await preview.play();
    setMicCheckPreviewPlaying(true);
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

  const renderHostRecordingPanel = () => {
    if (!isAdmin || hostRecording.status === 'idle') return null;
    const progress = hostRecording.status === 'ready'
      ? 100
      : Math.min(100, hostRecording.durationMs
        ? (hostRecording.elapsedMs / hostRecording.durationMs) * 100
        : 0);
    return (
      <div style={{
        width: '100%',
        maxWidth: '680px',
        padding: '1rem 1.2rem',
        borderRadius: '14px',
        border: '1px solid var(--glass-border)',
        background: 'var(--bg-dark)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        margin: '1rem auto 0'
      }}>
        <style>{'@keyframes karaokePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'}</style>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          fontWeight: '700'
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {hostRecording.status === 'recording' && (
              <span style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: '#ef4444',
                animation: 'karaokePulse 1.2s ease-in-out infinite'
              }} />
            )}
            {hostRecording.status === 'recording'
              ? t('question.karaokeRecording')
              : hostRecording.status === 'ready'
                ? t('question.karaokeRecordingReady')
                : t('question.karaokeRecordingEmpty')}
          </span>
          <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(hostRecording.elapsedMs)}
            {hostRecording.durationMs ? ` / ${formatDuration(hostRecording.durationMs)}` : ''}
          </span>
        </div>
        <div style={{
          height: '8px',
          borderRadius: '999px',
          overflow: 'hidden',
          background: 'var(--track)'
        }}>
          <div style={{
            height: '100%',
            width: `${progress}%`,
            background: 'var(--primary)',
            transition: 'width 250ms linear'
          }} />
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          {t('question.karaokeRecordingSize', {
            size: (hostRecording.bytes / (1024 * 1024)).toFixed(1)
          })}
        </div>
        {hostRecording.status === 'ready' && hostRecording.url && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            <audio
              ref={recordingAudioRef}
              src={hostRecording.url}
              controls
              preload="metadata"
              onLoadedMetadata={event => {
                event.currentTarget.volume = Math.min(1, Math.max(0, volume));
              }}
              style={{ width: '100%' }}
            />
            <a
              className="btn-primary"
              href={hostRecording.url}
              download={`karaoke-${questionId}-${hostRecording.performanceId}.webm`}
              style={{
                alignSelf: 'center',
                padding: '0.65rem 1.4rem',
                fontSize: '0.95rem',
                textDecoration: 'none'
              }}
            >
              {t('question.karaokeDownloadRecording')}
            </a>
          </div>
        )}
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
              {!calibration && micCheckStatus === 'idle' && (
                <div style={{ color: '#fbbf24', fontWeight: '700', fontSize: '0.95rem' }}>
                  {t('question.micCheckRecommended')}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  className="btn-primary"
                  style={{ padding: '0.9rem 2rem', fontSize: '1.1rem' }}
                  onClick={handleMicCheck}
                  disabled={micCheckStatus === 'running'}
                >
                  {calibration ? t('question.micCheckRedo') : t('question.micCheckButton')}
                </button>
                <button
                  className="btn-primary"
                  style={{ padding: '0.9rem 2rem', fontSize: '1.1rem' }}
                  onClick={handleStart}
                  disabled={micCheckStatus === 'running'}
                >
                  {live ? t('question.karaokeRestart') : t('question.karaokeStart')}
                </button>
              </div>

              {micCheckStatus === 'running' && (
                <div style={{
                  width: '100%',
                  padding: '1.25rem',
                  borderRadius: '16px',
                  border: '1px solid var(--glass-border)',
                  background: 'var(--bg-dark)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.85rem'
                }}>
                  <div style={{ fontSize: '1.15rem', fontWeight: '700' }}>
                    {micCheckBeat && micCheckBeat.phase === 'measure'
                      ? t('question.micCheckClap')
                      : t('question.micCheckListen')}
                  </div>
                  <div
                    key={micCheckBeat ? `${micCheckBeat.phase}-${micCheckBeat.index}` : 'waiting'}
                    aria-label={t('question.micCheckBeat')}
                    style={{
                      width: '92px',
                      height: '92px',
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      boxShadow: '0 0 32px var(--accent-glow)',
                      transform: micCheckBeat ? 'scale(1)' : 'scale(0.72)',
                      transition: 'transform 120ms ease-out',
                      animation: micCheckBeat ? 'micCheckBeatPulse 420ms ease-out' : 'none',
                      display: 'grid',
                      placeItems: 'center',
                      color: 'var(--bg-darker)',
                      fontSize: '1.6rem',
                      fontWeight: '900'
                    }}
                  >
                    {micCheckBeat && micCheckBeat.phase === 'measure'
                      ? micCheckBeat.index + 1
                      : micCheckBeat && micCheckBeat.phase === 'count-in'
                        ? micCheckBeat.total - micCheckBeat.index
                        : '...'}
                  </div>
                  <style>{'@keyframes micCheckBeatPulse { 0% { transform: scale(0.72); opacity: 0.65; } 45% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }'}</style>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    {t('question.micCheckProgress', {
                      count: micCheckProgress.detected,
                      total: micCheckProgress.total
                    })}
                    {micCheckProgress.estimateMs !== null
                      ? ` · ${micCheckProgress.estimateMs} ms`
                      : ''}
                  </div>
                </div>
              )}

              {calibration && micCheckStatus !== 'running' && (
                <div style={{
                  width: '100%',
                  padding: '1rem 1.25rem',
                  borderRadius: '14px',
                  border: '1px solid var(--glass-border)',
                  background: 'var(--bg-dark)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem'
                }}>
                  <div style={{ fontSize: '1.2rem', fontWeight: '800', color: 'var(--accent)' }}>
                    {t('question.micCheckResult', { ms: calibration.latencyMs })}
                  </div>
                  {calibration.confidence !== undefined && calibration.confidence < 0.6 && (
                    <div style={{ color: '#fbbf24' }}>{t('question.micCheckLowConfidence')}</div>
                  )}
                  {micCheckRecording && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {t('question.micCheckPlayback')}
                      </span>
                      <button
                        type="button"
                        className="mic-check-preview-btn"
                        disabled={!micCheckPreviewReady}
                        onClick={handleMicCheckPreview}
                      >
                        <span aria-hidden="true">{micCheckPreviewPlaying ? '■' : '▶'}</span>
                        {micCheckPreviewPlaying
                          ? t('question.micCheckStopPreview')
                          : t('question.micCheckPlayPreview')}
                      </button>
                      {micCheckPreviewReady && micCheckRecording.preview && (
                        <MicCheckTimeline
                          waveform={micCheckWaveform}
                          beatCount={micCheckRecording.preview.beatCount}
                          intervalMs={micCheckRecording.preview.intervalMs}
                          durationMs={micCheckRecording.preview.durationMs}
                          playheadMs={micCheckPlayheadMs}
                          label={t('question.micCheckWaveform')}
                        />
                      )}
                    </div>
                  )}
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {t('question.micCheckNudge', { value: nudgeMs > 0 ? `+${nudgeMs}` : nudgeMs })}
                    </span>
                    <input
                      type="range"
                      className="volume-slider"
                      min="-200"
                      max="200"
                      step="10"
                      value={nudgeMs}
                      onChange={event => handleNudge(event.target.value)}
                      style={{ width: '100%', background: 'var(--glass-border)' }}
                    />
                  </label>
                  <button type="button" className="mic-check-reset-btn" onClick={handleResetCalibration}>
                    <span aria-hidden="true">↺</span>
                    {t('question.micCheckReset')}
                  </button>
                </div>
              )}

              {micCheckStatus === 'error' && (
                <div style={{ color: '#ef4444', fontSize: '1rem' }}>
                  {t(`question.micCheckError.${micCheckError}`)}
                </div>
              )}
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
          {renderHostRecordingPanel()}
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
            {renderHostRecordingPanel()}
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
