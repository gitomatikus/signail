import {
  MicCheckError,
  aggregateMicCheckSamples,
  clearVoiceSyncOverride,
  computeTrackDuckGain,
  createKaraokeRecordingBlob,
  createMicCheckPreview,
  createMicCheckWaveform,
  detectOnsetsInBuffer,
  getVoiceSyncCalibration,
  getVoiceSyncOverride,
  getMicCheckVoiceOffsetMs,
  setVoiceSyncOverride,
  VOICE_SYNC_CHANGE_EVENT
} from './karaoke';

describe('aggregateMicCheckSamples', () => {
  test('drops outliers, including a slow first reaction', () => {
    const clicks = Array.from({ length: 8 }, (_, index) => index + 10);
    const deltasMs = [120, 318, 322, 319, 650, 325, 321, 317];
    const onsets = clicks.map((click, index) => click + deltasMs[index] / 1000);

    const result = aggregateMicCheckSamples(clicks, onsets);

    expect(result.latencyMs).toBe(320);
    expect(result.samples).toHaveLength(6);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  test('accepts three claps out of ten ticks, first tick included', () => {
    const clicks = Array.from({ length: 10 }, (_, index) => index + 10);
    const onsets = [
      clicks[0] + 0.30,
      clicks[5] + 0.31,
      clicks[9] + 0.32
    ];

    const result = aggregateMicCheckSamples(clicks, onsets);

    expect(result.latencyMs).toBe(310);
    expect(result.samples).toHaveLength(3);
  });

  test('reports low confidence for sparse, inconsistent claps', () => {
    const clicks = Array.from({ length: 8 }, (_, index) => index + 10);
    const onsets = [
      clicks[1] + 0.24,
      clicks[2] + 0.31,
      clicks[4] + 0.36,
      clicks[6] + 0.29
    ];

    const result = aggregateMicCheckSamples(clicks, onsets);

    expect(result.confidence).toBeLessThan(0.6);
  });

  test('throws a typed error when fewer than three beats are heard', () => {
    const clicks = Array.from({ length: 10 }, (_, index) => index + 10);
    const onsets = [clicks[2] + 0.3, clicks[7] + 0.3];
    expect(() => aggregateMicCheckSamples(clicks, onsets))
      .toThrow(expect.objectContaining({ code: 'no-onsets' }));
    expect(() => aggregateMicCheckSamples(clicks, onsets))
      .toThrow(MicCheckError);
  });
});

describe('detectOnsetsInBuffer', () => {
  test('finds known transients and debounces their tails', () => {
    const sampleRate = 48000;
    const samples = new Float32Array(sampleRate * 2);
    [0.4, 1.2].forEach(timeS => {
      const start = Math.round(timeS * sampleRate);
      for (let i = start; i < start + 900; i++) {
        samples[i] = 0.8 * Math.exp(-(i - start) / 220);
      }
    });

    const onsets = detectOnsetsInBuffer(samples, sampleRate, 0.05);

    expect(onsets).toHaveLength(2);
    expect(onsets[0]).toBeCloseTo(0.4, 1);
    expect(onsets[1]).toBeCloseTo(1.2, 1);
  });
});

describe('computeTrackDuckGain', () => {
  test('keeps the track a touch below the voice level', () => {
    expect(computeTrackDuckGain(0.1, 0.16)).toBeCloseTo(0.5);
  });

  test('clamps to the audible floor for quiet mics', () => {
    expect(computeTrackDuckGain(0.01, 0.3)).toBe(0.25);
  });

  test('clamps to the headroom ceiling for loud mics', () => {
    expect(computeTrackDuckGain(0.5, 0.1)).toBe(0.85);
  });

  test('falls back to the ceiling without valid measurements', () => {
    expect(computeTrackDuckGain(0, 0.2)).toBe(0.85);
    expect(computeTrackDuckGain(NaN, 0.2)).toBe(0.85);
    expect(computeTrackDuckGain(0.2, 0)).toBe(0.85);
  });
});

describe('mic check preview alignment', () => {
  test('advances the recorded voice by the selected sync value', () => {
    expect(getMicCheckVoiceOffsetMs(4800, 1200, 320)).toBe(6320);
  });

  test('moves waveform peaks earlier when sync increases', () => {
    const samples = new Float32Array(3000);
    samples[1500] = 1;
    const audioBuffer = {
      length: samples.length,
      sampleRate: 1000,
      numberOfChannels: 1,
      getChannelData: () => samples
    };

    const unshifted = createMicCheckWaveform(audioBuffer, 1000, 1000, 0, 10);
    const shifted = createMicCheckWaveform(audioBuffer, 1000, 1000, 200, 10);

    expect(unshifted.indexOf(1)).toBe(5);
    expect(shifted.indexOf(1)).toBe(3);
  });

  test('can destroy the same preview more than once', async () => {
    const close = jest.fn().mockImplementation(function closeContext() {
      this.state = 'closed';
      return Promise.resolve();
    });
    const audioContext = {
      state: 'running',
      currentTime: 0,
      destination: {},
      decodeAudioData: jest.fn().mockResolvedValue({
        duration: 2,
        length: 2000,
        sampleRate: 1000,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(2000)
      }),
      createGain: () => ({
        gain: { value: 1 },
        connect: jest.fn()
      }),
      close
    };
    const originalAudioContext = window.AudioContext;
    window.AudioContext = jest.fn(() => audioContext);

    try {
      const preview = await createMicCheckPreview({
        recordingBlob: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) },
        firstBeatOffsetMs: 0,
        beatCount: 2,
        intervalMs: 1000,
        durationMs: 2000,
        voiceSyncMs: 0
      });

      preview.destroy();
      preview.destroy();

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.AudioContext = originalAudioContext;
    }
  });
});

describe('voice sync persistence', () => {
  afterEach(() => clearVoiceSyncOverride());

  test('writes the pipeline override key and calibration metadata', () => {
    setVoiceSyncOverride(345, {
      measuredLatencyMs: 320,
      calibratedAt: '2026-06-13T00:00:00.000Z',
      source: 'mic-check'
    });

    expect(window.localStorage.getItem('karaokeVoiceSyncMs')).toBe('345');
    expect(getVoiceSyncOverride()).toBe(345);
    expect(getVoiceSyncCalibration()).toEqual({
      latencyMs: 345,
      measuredLatencyMs: 320,
      calibratedAt: '2026-06-13T00:00:00.000Z',
      source: 'mic-check'
    });
  });

  test('persists confidence and announces calibration changes', () => {
    const listener = jest.fn();
    window.addEventListener(VOICE_SYNC_CHANGE_EVENT, listener);

    setVoiceSyncOverride(280, {
      measuredLatencyMs: 260,
      source: 'mic-check',
      confidence: 0.91
    });

    expect(getVoiceSyncCalibration()).toEqual(expect.objectContaining({
      latencyMs: 280,
      measuredLatencyMs: 260,
      source: 'mic-check',
      confidence: 0.91
    }));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(VOICE_SYNC_CHANGE_EVENT, listener);
  });
});

describe('createKaraokeRecordingBlob', () => {
  test('sorts and deduplicates streamed chunks', async () => {
    const chunks = [
      { seq: 1, b64: btoa('world') },
      { seq: 0, b64: btoa('hello ') },
      { seq: 1, b64: btoa('world') }
    ];

    const blob = createKaraokeRecordingBlob(chunks);
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });

    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(text).toBe('hello world');
  });
});
