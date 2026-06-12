// Karaoke audio pipeline.
//
// The singer's client plays the karaoke track locally, mixes it with the
// microphone in Web Audio and streams the MIX as one MediaRecorder chunk
// sequence over the websocket. Because track and voice are combined before
// encoding they can never drift apart - listeners hear the performance in
// perfect sync no matter how bad the network latency is; the whole show is
// just uniformly a little behind, which nobody can perceive.
//
// The one lag that is NOT uniform sits inside the mix itself: the singer
// hears the track only after the output latency and their voice spends the
// input latency coming back through the mic, so a naive mix carries the
// voice a few hundred ms behind the track. The track branch is delayed by
// an estimate of that round trip to line the two up (see Singer side).
//
// Listeners feed the chunks into MediaSource Extensions. Chunks are only
// decodable as a prefix-complete sequence (the first one carries the WebM
// header), which is why the server keeps a backlog for late joiners.

const RECORDER_MIME = 'audio/webm;codecs=opus';
const CHUNK_MS = 250;
// Playback may fall behind the live edge after a stall; beyond this we jump
const MAX_LIVE_LAG_S = 2.5;
const LIVE_EDGE_OFFSET_S = 0.4;
// Voice-vs-track alignment inside the mix (see Singer side below)
const MAX_VOICE_SYNC_S = 1.5;
const FALLBACK_MIC_LATENCY_S = 0.08;
const VOICE_SYNC_OVERRIDE_KEY = 'karaokeVoiceSyncMs';

export const isKaraokeStreamingSupported = () =>
  typeof window.MediaRecorder !== 'undefined'
  && MediaRecorder.isTypeSupported
  && MediaRecorder.isTypeSupported(RECORDER_MIME)
  && typeof window.MediaSource !== 'undefined'
  && MediaSource.isTypeSupported(RECORDER_MIME);

// ---------- Lyrics (plain text or LRC "[mm:ss.xx] line") ----------

const LRC_TIME_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
// Enhanced-LRC inline word stamps: "[mm:ss.xx]<mm:ss.xx>Some <mm:ss.xx>words"
const WORD_TIME_RE = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;

const matchToMs = (match) => {
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  const fracRaw = match[3] || '';
  const fracMs = fracRaw.length === 0 ? 0
    : fracRaw.length === 1 ? parseInt(fracRaw, 10) * 100
      : fracRaw.length === 2 ? parseInt(fracRaw, 10) * 10
        : parseInt(fracRaw.slice(0, 3), 10);
  return (minutes * 60 + seconds) * 1000 + fracMs;
};

// Line content -> [{ timeMs|null, endMs|null, text }]: a <..> stamp times the
// word that follows it; words without a stamp carry null and ride along
// visually. A2 ends: two stamps with no word between ("word<..> <..>next")
// or a trailing stamp close the previous word at that time.
const parseLineWords = (content) => {
  const words = [];
  let pending = null;
  let sliceStart = 0;
  const pushSegment = (segment) => {
    for (const part of segment.split(/\s+/)) {
      if (!part) continue;
      words.push({ timeMs: pending, endMs: null, text: part });
      pending = null;
    }
  };
  WORD_TIME_RE.lastIndex = 0;
  let match;
  while ((match = WORD_TIME_RE.exec(content)) !== null) {
    pushSegment(content.slice(sliceStart, match.index));
    const ms = matchToMs(match);
    const prevChar = match.index > 0 ? content[match.index - 1] : '';
    const lastEndOpen = words.length > 0 && words[words.length - 1].endMs === null;
    if (pending !== null && lastEndOpen) {
      words[words.length - 1].endMs = pending;
      pending = ms;
    } else if (prevChar && prevChar !== '>' && !/\s/.test(prevChar) && lastEndOpen) {
      // Glued onto the word ("word<mm:ss.xx>"): its end, even when
      // untimed words follow
      words[words.length - 1].endMs = ms;
    } else {
      pending = ms;
    }
    sliceStart = WORD_TIME_RE.lastIndex;
  }
  pushSegment(content.slice(sliceStart));
  if (pending !== null && words.length > 0 && words[words.length - 1].endMs === null) {
    words[words.length - 1].endMs = pending; // trailing tag ends the last word
  }
  return words;
};

// -> [{ timeMs, text, words|null }] sorted by time; [] when nothing parses
// as LRC. `words` is only set when the line carries enhanced-LRC stamps.
export const parseLrc = (text) => {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [];
    let tailStart = 0;
    LRC_TIME_RE.lastIndex = 0;
    let match;
    while ((match = LRC_TIME_RE.exec(raw)) !== null) {
      // Timestamps must form a contiguous prefix ("[00:12.00][00:24.00]text")
      if (match.index !== tailStart) break;
      times.push(matchToMs(match));
      tailStart = LRC_TIME_RE.lastIndex;
    }
    if (times.length === 0) continue; // plain line or [ti:...] metadata tag
    const words = parseLineWords(raw.slice(tailStart));
    const content = words.map((w) => w.text).join(' ');
    const hasWordTimes = words.some((w) => w.timeMs !== null);
    for (const timeMs of times) {
      lines.push({ timeMs, text: content, words: hasWordTimes ? words : null });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
};

export const hasLrcTimestamps = (text) => parseLrc(text).length > 0;

// Index of the line being sung at trackTimeMs (-1 before the first line)
export const currentLrcIndex = (lines, trackTimeMs) => {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs <= trackTimeMs) {
      index = i;
    } else {
      break;
    }
  }
  return index;
};

// ---------- Shared helpers ----------

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result || '';
    resolve(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1));
  };
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const base64ToBytes = (b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// Karaoke media in packs is a base64 data URL; element src and MSE work much
// better with a Blob URL (no megabytes-long attribute value). Falls back to
// the original string if it isn't a data URL.
export const dataUrlToObjectUrl = (dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return dataUrl;
  }
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(5, comma);
  const mime = meta.split(';')[0] || 'application/octet-stream';
  const bytes = base64ToBytes(dataUrl.slice(comma + 1));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
};

export const isVideoMedia = (mediaDataUrl) =>
  typeof mediaDataUrl === 'string' && mediaDataUrl.startsWith('data:video');

// ---------- Singer side ----------

// createMediaElementSource may only ever be called once per element, and the
// element goes permanently silent if its AudioContext is closed - so the
// context+graph live on the element and survive pipeline restarts. Only the
// permanent nodes are cached; the mix chain is rebuilt per performance in
// startSingerPipeline (a reused delay line would replay the tail of the
// previous attempt into a restart).
const getElementGraph = (mediaEl) => {
  if (!mediaEl.__karaokeGraph) {
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextImpl();
    const source = ctx.createMediaElementSource(mediaEl);
    // Monitor branch: what the singer hears locally. Its gain is the singer's
    // private volume knob - it must NOT affect the recorded mix.
    const monitorGain = ctx.createGain();
    source.connect(monitorGain);
    monitorGain.connect(ctx.destination);
    mediaEl.__karaokeGraph = { ctx, source, monitorGain };
  }
  return mediaEl.__karaokeGraph;
};

// The track enters the mix digitally (zero latency), but the singer only
// hears it after the output latency, and their answer to it spends the input
// latency travelling back through the mic stack - so in a naive mix every
// sung note lands outLat+inLat behind the track moment it belongs to
// (~150ms wired, easily 0.5s on Bluetooth) and listeners hear the singer
// permanently late. Delaying the track branch by that estimate lines the
// two back up.
const estimateVoiceSyncS = (ctx, micStream) => {
  let inputLatencyS = FALLBACK_MIC_LATENCY_S;
  const track = micStream.getAudioTracks()[0];
  const reported = track && track.getSettings ? track.getSettings().latency : undefined;
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    // Browsers tend to report the requested ideal rather than the real
    // capture latency - never trust a value below the realistic floor
    inputLatencyS = Math.max(reported, FALLBACK_MIC_LATENCY_S);
  }
  const outputLatencyS = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  return Math.min(MAX_VOICE_SYNC_S, outputLatencyS + inputLatencyS);
};

// Builds the mix graph around mediaEl and starts streaming. The element's own
// volume is pinned to 1 (it feeds the recording!); local loudness goes through
// the monitor gain instead. Mic failure is tolerated: the game must go on,
// the stream just carries the bare track and the caller shows a warning.
export const startSingerPipeline = async ({ mediaEl, monitorVolume, onChunk }) => {
  if (!isKaraokeStreamingSupported()) {
    throw new Error('karaoke-unsupported');
  }
  const { ctx, source, monitorGain } = getElementGraph(mediaEl);

  // The volume manager must not touch this element: its volume scales the
  // samples entering the graph, i.e. the recorded mix for everyone
  mediaEl.__karaokePinnedVolume = true;
  mediaEl.__programmaticChange = true;
  mediaEl.volume = 1;
  mediaEl.muted = false;
  mediaEl.__programmaticChange = false;
  monitorGain.gain.value = Math.min(1, Math.max(0, monitorVolume ?? 1));

  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  let micStream = null;
  let micSource = null;
  try {
    // Speech-tuned processing eats sustained notes: keep the voice raw.
    // The singer is told to wear headphones, so echo cancellation is off too.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    micSource = ctx.createMediaStreamSource(micStream);
  } catch (e) {
    console.warn('Karaoke: microphone unavailable, streaming track only', e);
  }

  // No mic means no voice to align. Otherwise the estimate can be overridden
  // (in ms) from localStorage for setups that defy estimation.
  let voiceSyncS = micSource ? estimateVoiceSyncS(ctx, micStream) : 0;
  if (micSource) {
    try {
      const overrideMs = parseFloat(window.localStorage.getItem(VOICE_SYNC_OVERRIDE_KEY));
      if (Number.isFinite(overrideMs)) {
        voiceSyncS = Math.min(MAX_VOICE_SYNC_S, Math.max(0, overrideMs / 1000));
      }
    } catch (e) { /* storage blocked - keep the estimate */ }
    console.info(`Karaoke: track delayed ${Math.round(voiceSyncS * 1000)}ms to align the voice (override: localStorage.${VOICE_SYNC_OVERRIDE_KEY})`);
  }
  const voiceSyncMs = Math.round(voiceSyncS * 1000);

  // Mix destination: delayed track + mic, encoded and streamed to everyone
  const mixDest = ctx.createMediaStreamDestination();
  const trackGain = ctx.createGain();
  trackGain.gain.value = 0.85; // headroom so the voice sits on top
  const trackDelay = ctx.createDelay(MAX_VOICE_SYNC_S);
  trackDelay.delayTime.value = voiceSyncS;
  source.connect(trackGain);
  trackGain.connect(trackDelay);
  trackDelay.connect(mixDest);
  if (micSource) {
    micSource.connect(mixDest);
  }

  const recorder = new MediaRecorder(mixDest.stream, {
    mimeType: RECORDER_MIME,
    audioBitsPerSecond: 96000
  });
  let seq = 0;
  let stopped = false;
  // FileReader completions could in principle land out of order; chunks must
  // not - serialize the conversions
  let conversionChain = Promise.resolve();
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    // On the delayed clock: the track position the mix actually contains now
    const t = Math.max(0, Math.round((mediaEl.currentTime || 0) * 1000 - voiceSyncMs));
    const mySeq = seq++;
    conversionChain = conversionChain
      .then(() => blobToBase64(event.data))
      .then((b64) => onChunk({ seq: mySeq, b64, t }))
      .catch((e) => console.error('Karaoke: chunk encode failed', e));
  };
  recorder.start(CHUNK_MS);

  return {
    micActive: !!micStream,
    voiceSyncMs,
    setMonitorVolume: (value) => {
      monitorGain.gain.value = Math.min(1, Math.max(0, value));
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop(); // flushes a final dataavailable with the tail
        }
      } catch (e) { /* already gone */ }
      try { source.disconnect(trackGain); } catch (e) { /* detached */ }
      if (micSource) {
        try { micSource.disconnect(); } catch (e) { /* detached */ }
      }
      if (micStream) {
        micStream.getTracks().forEach((track) => track.stop());
      }
      // ctx and the element graph stay alive: closing the context would
      // permanently silence the media element (see getElementGraph)
    }
  };
};

// ---------- Listener side ----------

// Feeds karaoke chunks into an <audio> element via MSE. Chunks are appended
// strictly in seq order (backlog and live messages may interleave after a
// karaoke_sync) and the playhead is kept near the live edge.
export const createListenerPlayer = ({ audioEl, onAutoplayBlocked }) => {
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  let sourceBuffer = null;
  let destroyed = false;
  let finalized = false;
  let nextSeq = 0;
  const pending = new Map(); // seq -> bytes, waiting for their turn
  let lastChunkT = null; // track position at the end of the last appended chunk
  let appendedAny = false;

  const bufferedEnd = () => {
    try {
      const { buffered } = audioEl;
      return buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
    } catch (e) {
      return 0;
    }
  };

  const tryPlay = () => {
    if (!audioEl.paused || destroyed) return;
    const playResult = audioEl.play();
    if (playResult && playResult.catch) {
      playResult.catch(() => {
        // Autoplay policy refused unmuted playback - the UI shows a
        // "click to listen" button that calls resume()
        if (!destroyed && onAutoplayBlocked) onAutoplayBlocked();
      });
    }
  };

  const pump = () => {
    if (destroyed || !sourceBuffer || sourceBuffer.updating) return;
    const bytes = pending.get(nextSeq);
    if (bytes) {
      pending.delete(nextSeq);
      nextSeq += 1;
      try {
        sourceBuffer.appendBuffer(bytes);
        appendedAny = true;
      } catch (e) {
        console.error('Karaoke: appendBuffer failed', e);
      }
      return;
    }
    if (finalized && pending.size === 0 && mediaSource.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch (e) { /* already ended */ }
    }
  };

  mediaSource.addEventListener('sourceopen', () => {
    if (destroyed || sourceBuffer) return;
    sourceBuffer = mediaSource.addSourceBuffer(RECORDER_MIME);
    sourceBuffer.addEventListener('updateend', () => {
      if (destroyed) return;
      tryPlay();
      // Fell behind the live edge (tab throttling, network stall): jump
      const end = bufferedEnd();
      if (end - audioEl.currentTime > MAX_LIVE_LAG_S) {
        audioEl.currentTime = Math.max(0, end - LIVE_EDGE_OFFSET_S);
      }
      pump();
    });
    pump();
  });

  audioEl.src = objectUrl;

  return {
    push: ({ seq, b64, t }) => {
      if (destroyed || typeof seq !== 'number' || seq < nextSeq || pending.has(seq)) {
        return; // duplicate (sync backlog overlapping live relay) - drop
      }
      try {
        pending.set(seq, base64ToBytes(b64));
      } catch (e) {
        return; // malformed base64 - skip rather than kill the stream
      }
      if (typeof t === 'number' && t >= 0) {
        lastChunkT = Math.max(lastChunkT ?? 0, t);
      }
      pump();
    },
    // The performance ended: let playback drain the buffer and stop naturally
    finalize: () => {
      finalized = true;
      pump();
    },
    resume: () => tryPlay(),
    hasAudio: () => appendedAny,
    // What the listener is hearing right now, on the track's own clock -
    // drives lyrics highlighting and local muted-video sync
    getTrackTimeMs: () => {
      if (lastChunkT === null) return null;
      const lag = Math.max(0, bufferedEnd() - audioEl.currentTime);
      return Math.max(0, lastChunkT - lag * 1000);
    },
    destroy: () => {
      destroyed = true;
      pending.clear();
      try {
        if (audioEl) {
          audioEl.pause();
          audioEl.removeAttribute('src');
          audioEl.load();
        }
      } catch (e) { /* tearing down */ }
      URL.revokeObjectURL(objectUrl);
    }
  };
};
