import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/LanguageContext';

// Records a short voice clip with MediaRecorder and hands the parent back a
// base64 data URL (the same shape pasted/drawn images use), so a recording can
// be submitted as a text-field answer value. Opus at a low bitrate keeps a
// couple of minutes well under the server's answer-size limit.
const MAX_AUDIO_CHARS = 6000000; // server cap is 8M chars; leave headroom
const MAX_DURATION_MS = 120000; // auto-stop after 2 minutes

export const isAudioRecordingSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function' &&
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined';

const pickMimeType = () => {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const type of candidates) {
    if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
};

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

const formatTime = (totalSeconds) => {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const AudioRecorder = ({ onRecorded, buttonStyle = {}, disabled = false }) => {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const tickRef = useRef(null);
  const autoStopRef = useRef(null);

  const cleanupStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const clearTimers = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  };

  // Stop and release everything if the component unmounts mid-recording
  useEffect(() => () => {
    clearTimers();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch (e) { /* already stopping */ }
    }
    cleanupStream();
  }, []);

  const stop = () => {
    clearTimers();
    setRecording(false);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined
      );
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        cleanupStream();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size) {
          setError(t('audio.error'));
          return;
        }
        try {
          const dataUrl = await blobToDataUrl(blob);
          if (typeof dataUrl === 'string' && dataUrl.length <= MAX_AUDIO_CHARS) {
            onRecorded(dataUrl);
          } else {
            setError(t('audio.tooLong'));
          }
        } catch (e) {
          setError(t('audio.error'));
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setSeconds(0);
      tickRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      autoStopRef.current = setTimeout(stop, MAX_DURATION_MS);
    } catch (e) {
      cleanupStream();
      setError(t('audio.permission'));
    }
  };

  if (!isAudioRecordingSupported()) {
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem' }}>
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={disabled && !recording}
        style={{
          ...buttonStyle,
          background: recording ? '#ef4444' : 'var(--input-bg)',
          color: recording ? '#fff' : 'var(--text-primary)',
          border: recording ? '1px solid #ef4444' : '1px solid var(--glass-border)',
          opacity: disabled && !recording ? 0.5 : 1,
          cursor: disabled && !recording ? 'not-allowed' : 'pointer'
        }}
      >
        {recording ? `⏹ ${t('audio.stop')} ${formatTime(seconds)}` : `🎤 ${t('audio.record')}`}
      </button>
      {error && (
        <span style={{ fontSize: '0.85rem', color: '#ef4444', textAlign: 'center' }}>{error}</span>
      )}
    </div>
  );
};

export default AudioRecorder;
