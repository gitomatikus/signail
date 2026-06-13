import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/LanguageContext';
import {
  VOICE_SYNC_CHANGE_EVENT,
  clearVoiceSyncOverride,
  createMicCheckPreview,
  getVoiceSyncCalibration,
  runMicCheck,
  setVoiceSyncOverride
} from '../utils/karaoke';

const MicCheckTimeline = ({ waveform, preview, playheadMs }) => {
  const width = 1000;
  const height = 130;
  const centerY = 68;
  const barWidth = width / Math.max(1, waveform.length);
  return (
    <svg
      role="img"
      aria-label="Mic check timing waveform"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{
        display: 'block',
        width: '100%',
        height: '105px',
        borderRadius: '8px',
        background: 'rgba(0, 0, 0, 0.2)',
        border: '1px solid var(--glass-border)'
      }}
    >
      <line x1="0" x2={width} y1={centerY} y2={centerY} stroke="var(--glass-border)" strokeWidth="2" />
      {waveform.map((amplitude, index) => {
        const barHeight = Math.max(2, amplitude * 46);
        return (
          <rect
            key={index}
            x={index * barWidth}
            y={centerY - barHeight / 2}
            width={Math.max(1, barWidth * 0.72)}
            height={barHeight}
            rx="1"
            fill="var(--accent)"
            opacity="0.8"
          />
        );
      })}
      {Array.from({ length: preview.beatCount }, (_, index) => {
        const x = index * preview.intervalMs / preview.durationMs * width;
        return (
          <g key={index}>
            <line x1={x} x2={x} y1="10" y2={height - 10} stroke="var(--accent)" strokeWidth="5" />
            <circle cx={x} cy="10" r="6" fill="var(--accent)" />
          </g>
        );
      })}
      <line
        x1={Math.min(width, Math.max(0, playheadMs / preview.durationMs * width))}
        x2={Math.min(width, Math.max(0, playheadMs / preview.durationMs * width))}
        y1="0"
        y2={height}
        stroke="#fff"
        strokeWidth="3"
        opacity="0.9"
      />
    </svg>
  );
};

const MicCheckSetting = () => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState('idle');
  const [beat, setBeat] = useState(null);
  const [progress, setProgress] = useState({ detected: 0, total: 8, estimateMs: null });
  const [error, setError] = useState(null);
  const [calibration, setCalibration] = useState(() => getVoiceSyncCalibration());
  const [nudgeMs, setNudgeMs] = useState(() => {
    const saved = getVoiceSyncCalibration();
    return saved ? saved.latencyMs - saved.measuredLatencyMs : 0;
  });
  const [recording, setRecording] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [waveform, setWaveform] = useState([]);
  const [playheadMs, setPlayheadMs] = useState(0);

  const abortRef = useRef(null);
  const previewRef = useRef(null);
  const playheadRafRef = useRef(null);
  const calibrationRef = useRef(calibration);

  useEffect(() => {
    calibrationRef.current = calibration;
  }, [calibration]);

  useEffect(() => {
    const syncCalibration = () => {
      const saved = getVoiceSyncCalibration();
      setCalibration(saved);
      setNudgeMs(saved ? saved.latencyMs - saved.measuredLatencyMs : 0);
    };
    window.addEventListener(VOICE_SYNC_CHANGE_EVENT, syncCalibration);
    return () => window.removeEventListener(VOICE_SYNC_CHANGE_EVENT, syncCalibration);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (previewRef.current) {
      previewRef.current.destroy();
      previewRef.current = null;
    }
    setPreviewReady(false);
    setPreviewPlaying(false);
    setWaveform([]);
    setPlayheadMs(0);
    if (!recording) return undefined;
    createMicCheckPreview({
      ...recording.preview,
      recordingBlob: recording.blob,
      voiceSyncMs: calibrationRef.current ? calibrationRef.current.latencyMs : 0,
      onEnded: () => {
        setPreviewPlaying(false);
        setPlayheadMs(0);
      }
    }).then((preview) => {
      if (cancelled) {
        if (preview) preview.destroy();
        return;
      }
      previewRef.current = preview;
      setPreviewReady(!!preview);
      setWaveform(preview ? preview.getWaveform() : []);
    }).catch(() => setPreviewReady(false));
    return () => {
      cancelled = true;
      if (previewRef.current) {
        previewRef.current.destroy();
        previewRef.current = null;
      }
    };
  }, [recording]);

  useEffect(() => {
    if (!previewPlaying) return undefined;
    const update = () => {
      const preview = previewRef.current;
      if (!preview || !preview.isPlaying()) {
        setPreviewPlaying(false);
        return;
      }
      setPlayheadMs(preview.getPositionMs());
      playheadRafRef.current = requestAnimationFrame(update);
    };
    playheadRafRef.current = requestAnimationFrame(update);
    return () => {
      if (playheadRafRef.current) cancelAnimationFrame(playheadRafRef.current);
      playheadRafRef.current = null;
    };
  }, [previewPlaying]);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
    if (previewRef.current) previewRef.current.destroy();
    if (playheadRafRef.current) cancelAnimationFrame(playheadRafRef.current);
  }, []);

  const handleCheck = async () => {
    if (abortRef.current) abortRef.current.abort();
    if (previewRef.current) {
      previewRef.current.destroy();
      previewRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setExpanded(true);
    setStatus('running');
    setBeat({ phase: 'ready', index: 0, total: 4 });
    setProgress({ detected: 0, total: 8, estimateMs: null });
    setError(null);
    setRecording(null);
    try {
      const result = await runMicCheck({
        signal: controller.signal,
        onBeat: setBeat,
        onProgress: setProgress
      });
      const latencyMs = setVoiceSyncOverride(result.latencyMs, {
        measuredLatencyMs: result.latencyMs,
        source: 'mic-check',
        confidence: result.confidence
      });
      const nextCalibration = {
        latencyMs,
        measuredLatencyMs: result.latencyMs,
        calibratedAt: new Date().toISOString(),
        source: 'mic-check',
        confidence: result.confidence
      };
      setCalibration(nextCalibration);
      setNudgeMs(0);
      if (result.recordingBlob && result.recordingBlob.size > 0 && result.preview) {
        setRecording({ blob: result.recordingBlob, preview: result.preview });
      }
      setStatus('done');
      setBeat(null);
    } catch (checkError) {
      if (checkError && checkError.code === 'aborted') return;
      setStatus('error');
      setBeat(null);
      setError(checkError && checkError.code ? checkError.code : 'mic-denied');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
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
    setCalibration(previous => ({ ...previous, latencyMs }));
    setNudgeMs(latencyMs - measuredLatencyMs);
    if (previewRef.current) {
      previewRef.current.setVoiceSyncMs(latencyMs);
      setWaveform(previewRef.current.getWaveform());
    }
  };

  const handleReset = () => {
    clearVoiceSyncOverride();
    setCalibration(null);
    setNudgeMs(0);
    setStatus('idle');
    setRecording(null);
    setError(null);
  };

  const handlePreview = async () => {
    const preview = previewRef.current;
    if (!preview) return;
    if (preview.isPlaying()) {
      preview.stop();
      setPreviewPlaying(false);
      setPlayheadMs(preview.getPositionMs());
      return;
    }
    await preview.play();
    setPreviewPlaying(true);
  };

  const complete = !!calibration;
  return (
    <div className={`mic-check-setting ${complete ? 'is-complete' : 'is-incomplete'}`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: '600' }}>{t('settings.micCheck')}</div>
          <div className={`mic-check-status ${complete ? 'is-complete' : 'is-incomplete'}`} style={{ marginTop: '0.4rem' }}>
            <span aria-hidden="true">{complete ? '✓' : '×'}</span>
            <span>
              {complete
                ? t('settings.micCheckReady', { ms: calibration.latencyMs })
                : t('settings.micCheckMissing')}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setExpanded(value => !value)}
          style={{ padding: '0.55rem 0.9rem', whiteSpace: 'nowrap' }}
        >
          {expanded ? t('settings.micCheckHide') : complete ? t('settings.micCheckReview') : t('settings.micCheckStart')}
        </button>
      </div>

      {expanded && (
        <div className="mic-check-details" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            {t('settings.micCheckEncouragement')}
          </div>
          <button type="button" className="btn-primary" onClick={handleCheck} disabled={status === 'running'}>
            {complete ? t('question.micCheckRedo') : t('question.micCheckButton')}
          </button>

          {status === 'running' && (
            <div style={{
              textAlign: 'center',
              padding: '0.8rem',
              background: 'var(--input-bg)',
              border: '1px solid var(--glass-border)',
              borderRadius: '8px'
            }}>
              <div style={{ fontWeight: '700' }}>
                {beat && beat.phase === 'measure'
                  ? t('question.micCheckClap')
                  : t('question.micCheckListen')}
              </div>
              <div style={{
                width: '64px',
                height: '64px',
                margin: '0.7rem auto',
                display: 'grid',
                placeItems: 'center',
                borderRadius: '50%',
                background: 'var(--accent)',
                color: 'var(--bg-darker)',
                fontWeight: '900',
                fontSize: '1.3rem'
              }}>
                {beat && beat.phase === 'measure'
                  ? beat.index + 1
                  : beat && beat.phase === 'count-in'
                    ? beat.total - beat.index
                    : '...'}
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                {t('question.micCheckProgress', { count: progress.detected, total: progress.total })}
              </div>
            </div>
          )}

          {complete && status !== 'running' && (
            <>
              <div style={{ color: 'var(--accent)', fontWeight: '800', textAlign: 'center' }}>
                {t('question.micCheckResult', { ms: calibration.latencyMs })}
              </div>
              {recording && (
                <>
                  <button
                    type="button"
                    className="mic-check-preview-btn"
                    onClick={handlePreview}
                    disabled={!previewReady}
                  >
                    <span aria-hidden="true">{previewPlaying ? '■' : '▶'}</span>
                    {previewPlaying ? t('question.micCheckStopPreview') : t('question.micCheckPlayPreview')}
                  </button>
                  {previewReady && (
                    <MicCheckTimeline waveform={waveform} preview={recording.preview} playheadMs={playheadMs} />
                  )}
                </>
              )}
              <label style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', textAlign: 'center' }}>
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
              <button type="button" className="mic-check-reset-btn" onClick={handleReset}>
                <span aria-hidden="true">↺</span>
                {t('question.micCheckReset')}
              </button>
            </>
          )}

          {status === 'error' && (
            <div style={{ color: 'var(--danger)', textAlign: 'center' }}>
              {t(`question.micCheckError.${error}`)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MicCheckSetting;
