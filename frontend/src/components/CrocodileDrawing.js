import React, { useCallback, useEffect, useRef, useState } from 'react';
import wsManager from '../utils/websocket';
import { useTranslation } from '../i18n/LanguageContext';
import {
  DRAW_W,
  DRAW_H,
  PALETTE,
  createReplay,
  pointerToNorm,
} from '../utils/drawingEngine';

// Live crocodile "draw" mode. The chosen performer draws on a canvas whose
// pen-stroke ops stream to everyone in real time (mirrors the karaoke chunk
// pipeline); watchers replay those ops onto a read-only canvas while they type
// guesses (the guess field lives in QuestionPage, beside this surface). Either
// the performer ("Done") or the host ("End") concludes the round, at which
// point the performer's canvas is flattened to a PNG and submitted as the
// crocodile response — flipping everyone into the normal reveal/score step.
//
// mode: 'performer' | 'host' | 'watcher'
// onFinish(pngDataUrl): performer only — submit the flattened drawing.
// idleHidden: watcher/host render nothing until a drawing is actually streaming
//   (used by cat-in-the-bag, where drawing is optional). Crocodile leaves it
//   false so the canvas shows as soon as the round begins.

const newPerformanceId = (userId) => `${userId || 'p'}-${Date.now()}-${Math.floor(performance.now())}`;

const CrocodileDrawing = ({ questionId, mode, currentUserId, onFinish, idleHidden = false }) => {
  const { t } = useTranslation();
  const isPerformer = mode === 'performer';
  const isHost = mode === 'host';

  const canvasRef = useRef(null);
  const replayRef = useRef(null);

  // Performer send state
  const perfIdRef = useRef(null);
  const seqRef = useRef(0);
  const pendingOpsRef = useRef([]);
  const rafRef = useRef(null);
  const drawingRef = useRef(false);
  const strokeIdRef = useRef(0);
  const finishedRef = useRef(false);

  // Watcher receive state
  const watchPerfRef = useRef(null);
  const seenSeqRef = useRef(new Set());
  const stashRef = useRef([]); // strokes that arrived before the perf id was known

  const [color, setColor] = useState('#000000');
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState('brush'); // 'brush' | 'fill' | 'eraser'
  const [ended, setEnded] = useState(false);
  const [active, setActive] = useState(false); // a drawing is/was streaming

  // Bind the replay controller to the canvas once it is mounted/sized.
  const ensureReplay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    if (!replayRef.current) {
      const ctx = canvas.getContext('2d');
      replayRef.current = createReplay(ctx);
    }
    return replayRef.current;
  }, []);

  // ----- Performer: stream strokes -----

  const flush = useCallback(() => {
    if (pendingOpsRef.current.length && perfIdRef.current) {
      const ops = pendingOpsRef.current;
      pendingOpsRef.current = [];
      wsManager.sendDrawingStroke(questionId, perfIdRef.current, seqRef.current++, ops);
    }
    rafRef.current = window.requestAnimationFrame(flush);
  }, [questionId]);

  // Queue an op for sending, coalescing consecutive 'points' for the same stroke
  // into one op so a frame's moves become a single small payload.
  const queueOp = (op) => {
    const buf = pendingOpsRef.current;
    const last = buf[buf.length - 1];
    if (op.op === 'points' && last && last.op === 'points' && last.id === op.id) {
      last.pts.push(...op.pts);
    } else {
      buf.push(op);
    }
  };

  // Apply locally (immediate feedback) AND queue for the watchers.
  const emit = (op) => {
    const replay = ensureReplay();
    if (replay) replay.apply(op);
    queueOp(op);
  };

  const startPerformance = useCallback(() => {
    finishedRef.current = false;
    const id = newPerformanceId(currentUserId);
    perfIdRef.current = id;
    seqRef.current = 0;
    pendingOpsRef.current = [];
    const replay = ensureReplay();
    if (replay) replay.reset();
    setEnded(false);
    wsManager.sendDrawingStart(questionId, id);
  }, [questionId, currentUserId, ensureReplay]);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    finishedRef.current = true;
    // Composite onto white so the response card shows the drawing on a solid bg.
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, off.width, off.height);
    octx.drawImage(canvas, 0, 0);
    const png = off.toDataURL('image/png');
    wsManager.sendDrawingEnd(questionId, perfIdRef.current);
    if (onFinish) onFinish(png);
  }, [questionId, onFinish]);

  // ----- Performer pointer handlers -----

  const handlePointerDown = (e) => {
    if (!isPerformer || ended) return;
    e.preventDefault();
    const p = pointerToNorm(e, canvasRef.current);
    if (tool === 'fill') {
      emit({ op: 'fill', color, x: p.x, y: p.y });
      return;
    }
    canvasRef.current.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const id = ++strokeIdRef.current;
    e.currentTarget.__strokeId = id;
    emit({ op: 'begin', id, tool, color, size: size / DRAW_W, x: p.x, y: p.y });
  };

  const handlePointerMove = (e) => {
    if (!isPerformer || !drawingRef.current) return;
    const id = e.currentTarget.__strokeId;
    if (id == null) return;
    const p = pointerToNorm(e, canvasRef.current);
    emit({ op: 'points', id, pts: [p.x, p.y] });
  };

  const endStroke = (e) => {
    if (!isPerformer || !drawingRef.current) return;
    drawingRef.current = false;
    const id = e.currentTarget.__strokeId;
    e.currentTarget.__strokeId = null;
    if (id != null) emit({ op: 'end', id });
  };

  const undo = () => { if (isPerformer) emit({ op: 'undo' }); };
  const clear = () => { if (isPerformer) emit({ op: 'clear' }); };

  // ----- Performer lifecycle: start + rAF flush + reconnect -----
  useEffect(() => {
    if (!isPerformer) return undefined;
    startPerformance();
    rafRef.current = window.requestAnimationFrame(flush);
    const unsub = wsManager.subscribe((data) => {
      if (data.type === 'ws_open') {
        // Reconnected mid-draw: mint a fresh performance (watchers reset).
        startPerformance();
      } else if (data.type === 'drawing_end'
        && data.data.questionId === questionId
        && data.data.performanceId === perfIdRef.current) {
        // The host ended the round — submit our drawing so everyone advances.
        setEnded(true);
        finish();
      }
    });
    return () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPerformer, questionId]);

  // ----- Watcher/host lifecycle: sync + replay incoming ops -----
  useEffect(() => {
    if (isPerformer) return undefined;

    const applyStroke = (d) => {
      if (watchPerfRef.current && d.performanceId === watchPerfRef.current) {
        if (seenSeqRef.current.has(d.seq)) return;
        seenSeqRef.current.add(d.seq);
        const replay = ensureReplay();
        if (replay && Array.isArray(d.ops)) d.ops.forEach((op) => replay.apply(op));
      } else if (!watchPerfRef.current) {
        stashRef.current.push(d);
        if (stashRef.current.length > 8000) stashRef.current.shift();
      }
    };

    const adoptPerformance = (id, isEnded) => {
      if (watchPerfRef.current === id) {
        if (isEnded) setEnded(true);
        return;
      }
      watchPerfRef.current = id;
      setActive(true);
      seenSeqRef.current = new Set();
      const replay = ensureReplay();
      if (replay) replay.reset();
      setEnded(!!isEnded);
      // Drain anything that raced ahead of the state/start message.
      const stash = stashRef.current;
      stashRef.current = [];
      stash.forEach(applyStroke);
    };

    const unsub = wsManager.subscribe((data) => {
      if (!data || !data.data || data.data.questionId !== questionId) return;
      if (data.type === 'drawing_start') {
        adoptPerformance(data.data.performanceId, false);
      } else if (data.type === 'drawing_state') {
        const perf = data.data.performance;
        if (perf) adoptPerformance(perf.id, perf.ended);
      } else if (data.type === 'drawing_stroke') {
        applyStroke(data.data);
      } else if (data.type === 'drawing_end') {
        if (data.data.performanceId === watchPerfRef.current) setEnded(true);
      } else if (data.type === 'ws_open') {
        // handled below (resync)
      }
    });

    const requestSync = () => wsManager.sendDrawingSync(questionId);
    requestSync();
    const unsubOpen = wsManager.subscribe((data) => {
      if (data.type === 'ws_open') requestSync();
    });

    return () => { unsub(); unsubOpen(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPerformer, questionId]);

  const hostEnd = () => wsManager.sendDrawingEnd(questionId, watchPerfRef.current);

  // ----- UI -----
  const toolBtn = (active) => ({
    padding: '0.4rem 0.7rem',
    borderRadius: '8px',
    border: active ? '1px solid var(--primary)' : '1px solid var(--glass-border)',
    background: active ? 'var(--primary)' : 'var(--input-bg)',
    color: active ? '#fff' : 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontFamily: 'inherit',
    fontWeight: 600,
  });
  const swatchBorder = (c) =>
    c.toLowerCase() === '#ffffff' ? '1px solid var(--glass-border)' : '1px solid transparent';

  const canvasEl = (
    <div style={{ display: 'flex', justifyContent: 'center', background: 'var(--input-bg)', borderRadius: '8px', padding: '0.5rem' }}>
      <canvas
        ref={canvasRef}
        width={DRAW_W}
        height={DRAW_H}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerLeave={endStroke}
        style={{
          width: '100%',
          maxWidth: DRAW_W,
          aspectRatio: `${DRAW_W} / ${DRAW_H}`,
          borderRadius: 6,
          background: '#ffffff',
          touchAction: 'none',
          cursor: isPerformer && !ended ? 'crosshair' : 'default',
        }}
      />
    </div>
  );

  if (!isPerformer) {
    // Cat-in-the-bag: nothing to show until the chosen player actually draws.
    if (idleHidden && !active) return null;
    // Watcher / host: read-only canvas, plus a host-only End control.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%' }}>
        {canvasEl}
        {isHost && active && !ended && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button style={toolBtn(false)} onClick={hostEnd}>⏹ {t('question.crocodileEndDrawing')}</button>
          </div>
        )}
      </div>
    );
  }

  // Performer: full toolbar + Done.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
          {PALETTE.map((c) => (
            <div
              key={c}
              onClick={() => { setColor(c); if (tool === 'eraser') setTool('brush'); }}
              title={c}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: c,
                cursor: 'pointer',
                border: swatchBorder(c),
                outline: tool !== 'eraser' && color === c ? '2px solid var(--primary)' : 'none',
                outlineOffset: '2px',
              }}
            />
          ))}
          <input
            type="color"
            value={color}
            onChange={(e) => { setColor(e.target.value); if (tool === 'eraser') setTool('brush'); }}
            title={t('paint.customColor')}
            style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('paint.brushSize')}</span>
          <input
            type="range"
            className="volume-slider"
            min={1}
            max={40}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            style={{
              width: 90,
              background: `linear-gradient(to right, var(--primary) ${((size - 1) / 39) * 100}%, var(--track) ${((size - 1) / 39) * 100}%)`,
            }}
          />
        </div>

        <button style={toolBtn(tool === 'brush')} onClick={() => setTool('brush')}>🖌 {t('paint.brush')}</button>
        <button style={toolBtn(tool === 'fill')} onClick={() => setTool('fill')}>🪣 {t('paint.fill')}</button>
        <button style={toolBtn(tool === 'eraser')} onClick={() => setTool('eraser')}>🧽 {t('paint.eraser')}</button>
        <button style={toolBtn(false)} onClick={undo} title={t('paint.undo')}>↶ {t('paint.undo')}</button>
        <button style={toolBtn(false)} onClick={clear} title={t('paint.clear')}>🗑 {t('paint.clear')}</button>
      </div>

      {canvasEl}

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button onClick={finish} className="btn-primary" style={{ ...toolBtn(true), padding: '0.5rem 1.4rem' }}>
          ✓ {t('question.crocodileDoneDrawing')}
        </button>
      </div>
    </div>
  );
};

export default CrocodileDrawing;
