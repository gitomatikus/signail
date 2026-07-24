import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from '../i18n/LanguageContext';
import { PALETTE, floodFill } from '../utils/drawingEngine';
import wsManager from '../utils/websocket';

// A freehand drawing pad shown as a fullscreen modal. Players use it to draw
// their answer to a text-answer question; on apply it exports a PNG data URL
// (the same format a pasted image produces), so the rest of the answer flow is
// unchanged. Ported from the pack editor's PaintCanvas — plain canvas, no deps.
//
// The canvas layer itself is always kept transparent — the background colour is
// composited in only on export — so the background can be changed at any time
// without destroying the drawing.

const DEFAULT_W = 720;
const DEFAULT_H = 720;
const MAX_W = 1280;
const MAX_H = 720;
// Checkerboard shown behind the (transparent) canvas so the user can tell
// where it is see-through.
const CHECKER = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #d0d0d0 25%, transparent 25%), linear-gradient(-45deg, #d0d0d0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d0d0d0 75%), linear-gradient(-45deg, transparent 75%, #d0d0d0 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

// streamQuestionId: when set, the strokes drawn here are streamed live over the
// socket (drawing_* messages) so watchers see the drawing develop in real time.
// Used by the single designated answerer of a watchable question (crocodile
// performer / cat-in-the-bag chosen player). null = no streaming (private draw).
const DrawCanvas = ({ open, onClose, onApply, initialImage, streamQuestionId = null }) => {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const bgInputRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const historyRef = useRef([]);
  // Live-stream state (only used when streamQuestionId is set).
  const streamRef = useRef({ perfId: null, seq: 0, ops: [], raf: null, strokeId: 0 });

  const [dims, setDims] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const [baseImage, setBaseImage] = useState(null);
  const [baseToken, setBaseToken] = useState(0);
  const [color, setColor] = useState('#000000');
  const [bgColor, setBgColor] = useState('#ffffff'); // null = transparent
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState('brush'); // 'brush' | 'fill' | 'eraser'
  const [canUndo, setCanUndo] = useState(false);

  // Scale an image down to fit within the working resolution, keeping aspect.
  const fitDims = (img) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return { w: DEFAULT_W, h: DEFAULT_H };
    const scale = Math.min(1, MAX_W / w, MAX_H / h);
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  };

  const applyBase = useCallback((img) => {
    setBaseImage(img);
    setDims(fitDims(img));
    setBaseToken((tk) => tk + 1);
  }, []);

  const resetBlank = useCallback(() => {
    setBaseImage(null);
    setDims({ w: DEFAULT_W, h: DEFAULT_H });
    setBaseToken((tk) => tk + 1);
  }, []);

  // (Re)initialise whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setColor('#000000');
    setBgColor('#ffffff');
    setSize(4);
    setTool('brush');
    drawingRef.current = false;
    lastRef.current = null;
    if (initialImage) {
      loadImage(initialImage).then(applyBase).catch(resetBlank);
    } else {
      resetBlank();
    }
  }, [open, initialImage, applyBase, resetBlank]);

  // Draw any base image onto the (transparent) canvas after it is sized. Runs
  // after React has applied the width/height attributes (which clear the
  // canvas), so it must come last.
  useLayoutEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (baseImage) ctx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
    historyRef.current = [];
    setCanUndo(false);
  }, [open, dims, baseToken, baseImage]);

  const pushHistory = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.length > 30) historyRef.current.shift();
    setCanUndo(true);
  };

  const undo = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    const prev = historyRef.current.pop();
    if (ctx && prev) ctx.putImageData(prev, 0, 0);
    setCanUndo(historyRef.current.length > 0);
    if (streamQuestionId) streamRef.current.ops.push({ op: 'undo' });
  }, [streamQuestionId]);

  // Ctrl+Z / Cmd+Z undoes the last stroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, undo, onClose]);

  const pointFromEvent = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  // Queue a stream op (normalized 0..1), coalescing a frame's points into one.
  const streamEmit = (op) => {
    if (!streamQuestionId) return;
    const buf = streamRef.current.ops;
    const last = buf[buf.length - 1];
    if (op.op === 'points' && last && last.op === 'points' && last.id === op.id) {
      last.pts.push(...op.pts);
    } else {
      buf.push(op);
    }
  };
  // Normalized point/size against the current canvas backing store.
  const nx = (x) => x / (canvasRef.current?.width || DEFAULT_W);
  const ny = (y) => y / (canvasRef.current?.height || DEFAULT_H);

  // Open/close the live performance and pump queued ops once per frame.
  useEffect(() => {
    if (!open || !streamQuestionId) return undefined;
    const s = streamRef.current;
    s.perfId = `${streamQuestionId}-${Date.now()}-${Math.floor(performance.now())}`;
    s.seq = 0;
    s.ops = [];
    s.strokeId = 0;
    wsManager.sendDrawingStart(streamQuestionId, s.perfId);
    const flush = () => {
      if (s.ops.length) {
        const ops = s.ops;
        s.ops = [];
        wsManager.sendDrawingStroke(streamQuestionId, s.perfId, s.seq++, ops);
      }
      s.raf = window.requestAnimationFrame(flush);
    };
    s.raf = window.requestAnimationFrame(flush);
    return () => {
      if (s.raf) window.cancelAnimationFrame(s.raf);
      // Flush any tail, then end the performance (watchers freeze the picture).
      if (s.ops.length) wsManager.sendDrawingStroke(streamQuestionId, s.perfId, s.seq++, s.ops);
      s.ops = [];
      wsManager.sendDrawingEnd(streamQuestionId, s.perfId);
    };
  }, [open, streamQuestionId]);

  const handlePointerDown = (e) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = pointFromEvent(e);
    if (tool === 'fill') {
      pushHistory();
      ctx.globalCompositeOperation = 'source-over';
      floodFill(ctx, color, p.x, p.y);
      streamEmit({ op: 'fill', color, x: nx(p.x), y: ny(p.y) });
      return;
    }
    canvasRef.current?.setPointerCapture(e.pointerId);
    pushHistory();
    drawingRef.current = true;
    lastRef.current = p;
    // Draw a dot so a single click leaves a mark.
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    streamRef.current.strokeId += 1;
    streamEmit({ op: 'begin', id: streamRef.current.strokeId, tool, color, size: nx(size), x: nx(p.x), y: ny(p.y) });
  };

  const handlePointerMove = (e) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    const last = lastRef.current;
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    streamEmit({ op: 'points', id: streamRef.current.strokeId, pts: [nx(p.x), ny(p.y)] });
  };

  const endStroke = () => {
    if (drawingRef.current) streamEmit({ op: 'end', id: streamRef.current.strokeId });
    drawingRef.current = false;
    lastRef.current = null;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) ctx.globalCompositeOperation = 'source-over';
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    pushHistory();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    streamEmit({ op: 'clear' });
  };

  const handleBgChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => loadImage(reader.result).then(applyBase).catch(() => {});
      reader.readAsDataURL(file);
    }
    if (bgInputRef.current) bgInputRef.current.value = '';
  };

  const apply = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let url;
    if (bgColor) {
      // Composite the drawing over the chosen background colour.
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const octx = off.getContext('2d');
      octx.fillStyle = bgColor;
      octx.fillRect(0, 0, off.width, off.height);
      octx.drawImage(canvas, 0, 0);
      url = off.toDataURL('image/png');
    } else {
      // Transparent background — export the canvas as-is.
      url = canvas.toDataURL('image/png');
    }
    onApply(url);
    onClose();
  };

  if (!open) return null;

  const transparent = bgColor === null;

  // Shared button look so the toolbar matches the app's glass theme without MUI.
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

  // Portal to document.body: the composer that hosts this modal lives inside a
  // card with backdrop-filter, which creates its own stacking context and would
  // otherwise trap the modal's z-index — letting the player list (a later
  // sibling at the page root) paint over the modal's controls.
  const modalContent = (
    <div
      className="draw-canvas-modal"
      onPointerDown={(e) => {
        // Click on the dim backdrop (outside the panel) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        zIndex: 3000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        boxSizing: 'border-box',
      }}
    >
      <div
        className="draw-canvas-panel"
        style={{
          background: 'var(--card-bg, var(--input-bg))',
          border: '1px solid var(--glass-border)',
          borderRadius: '12px',
          padding: '1rem',
          width: '100%',
          maxWidth: '860px',
          maxHeight: '95vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85rem',
          boxShadow: '0 12px 48px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Title */}
        <div className="draw-canvas__header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            🖌 {t('paint.title')}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="draw-canvas__close" onClick={onClose} aria-label={t('common.close')} style={{ ...toolBtn(false), padding: '0.3rem 0.6rem' }}>
            ×
          </button>
        </div>

        <div className="draw-canvas__toolbar">
          {/* Row 1: foreground colours + brush size + tools */}
          <div className="draw-canvas__toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
            <div className="draw-canvas__palette" style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
              {PALETTE.map((c) => (
                <button
                  type="button"
                  className="draw-canvas__swatch"
                  key={c}
                  onClick={() => { setColor(c); if (tool === 'eraser') setTool('brush'); }}
                  title={c}
                  aria-label={c}
                  aria-pressed={tool !== 'eraser' && color === c}
                  style={{
                    width: 24,
                    height: 24,
                    padding: 0,
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
                className="draw-canvas__color-input"
                value={color}
                onChange={(e) => { setColor(e.target.value); if (tool === 'eraser') setTool('brush'); }}
                title={t('paint.customColor')}
                style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
              />
            </div>

            <div className="draw-canvas__size" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('paint.brushSize')}</span>
              <input
                type="range"
                className="volume-slider draw-canvas__size-slider"
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

            <div className="draw-canvas__tools">
              <button type="button" className="draw-canvas__tool" style={toolBtn(tool === 'brush')} onClick={() => setTool('brush')} title={t('paint.brush')}>
                <span aria-hidden="true">🖌</span><span className="draw-canvas__tool-label">{t('paint.brush')}</span>
              </button>
              <button type="button" className="draw-canvas__tool" style={toolBtn(tool === 'fill')} onClick={() => setTool('fill')} title={t('paint.fill')}>
                <span aria-hidden="true">🪣</span><span className="draw-canvas__tool-label">{t('paint.fill')}</span>
              </button>
              <button type="button" className="draw-canvas__tool" style={toolBtn(tool === 'eraser')} onClick={() => setTool('eraser')} title={t('paint.eraser')}>
                <span aria-hidden="true">🧽</span><span className="draw-canvas__tool-label">{t('paint.eraser')}</span>
              </button>
            </div>
          </div>

          {/* Row 2: background controls + image + undo/clear */}
          <div className="draw-canvas__toolbar-row draw-canvas__toolbar-row--secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
            <div className="draw-canvas__background">
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('paint.bg')}</span>
              <input
                type="color"
                className="draw-canvas__color-input"
                value={bgColor ?? '#ffffff'}
                onChange={(e) => setBgColor(e.target.value)}
                title={t('paint.bgColor')}
                style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer', opacity: transparent ? 0.4 : 1 }}
              />
              <button type="button" className="draw-canvas__tool" style={toolBtn(transparent)} onClick={() => setBgColor(transparent ? '#ffffff' : null)} title={t('paint.transparent')}>
                <span aria-hidden="true">▧</span><span className="draw-canvas__tool-label">{t('paint.transparent')}</span>
              </button>
              <button type="button" className="draw-canvas__tool" style={toolBtn(false)} onClick={() => bgInputRef.current?.click()} title={t('paint.image')}>
                <span aria-hidden="true">🖼</span><span className="draw-canvas__tool-label">{t('paint.image')}</span>
              </button>
            </div>

            <div className="draw-canvas__history-tools">
              <button type="button" className="draw-canvas__tool" style={{ ...toolBtn(false), opacity: canUndo ? 1 : 0.4 }} onClick={undo} disabled={!canUndo} title={t('paint.undo')}>
                <span aria-hidden="true">↶</span><span className="draw-canvas__tool-label">{t('paint.undo')}</span>
              </button>
              <button type="button" className="draw-canvas__tool" style={toolBtn(false)} onClick={clear} title={t('paint.clear')}>
                <span aria-hidden="true">🗑</span><span className="draw-canvas__tool-label">{t('paint.clear')}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="draw-canvas__canvas-frame" style={{ display: 'flex', justifyContent: 'center', background: 'var(--input-bg)', borderRadius: '8px', padding: '0.5rem' }}>
          <canvas
            ref={canvasRef}
            className="draw-canvas__canvas"
            width={dims.w}
            height={dims.h}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endStroke}
            onPointerLeave={endStroke}
            style={{
              width: '100%',
              maxWidth: dims.w,
              aspectRatio: `${dims.w} / ${dims.h}`,
              borderRadius: 6,
              touchAction: 'none',
              cursor: 'crosshair',
              ...(transparent ? CHECKER : { background: bgColor }),
            }}
          />
        </div>

        <input type="file" accept="image/*" ref={bgInputRef} style={{ display: 'none' }} onChange={handleBgChange} />

        {/* Actions */}
        <div className="draw-canvas__actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
          <button type="button" onClick={onClose} style={toolBtn(false)}>{t('common.cancel')}</button>
          <button type="button" onClick={apply} className="btn-primary draw-canvas__apply" style={{ ...toolBtn(true), padding: '0.5rem 1.1rem' }}>
            ✓ {t('paint.use')}
          </button>
        </div>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

export default DrawCanvas;
