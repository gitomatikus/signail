import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/LanguageContext';

// A freehand drawing pad shown as a fullscreen modal. Players use it to draw
// their answer to a text-answer question; on apply it exports a PNG data URL
// (the same format a pasted image produces), so the rest of the answer flow is
// unchanged. Ported from the pack editor's PaintCanvas — plain canvas, no deps.
//
// The canvas layer itself is always kept transparent — the background colour is
// composited in only on export — so the background can be changed at any time
// without destroying the drawing.

const DEFAULT_W = 720;
const DEFAULT_H = 420;
const MAX_W = 1280;
const MAX_H = 720;
const PALETTE = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];
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

const hexToRgba = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
};

const DrawCanvas = ({ open, onClose, onApply, initialImage }) => {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const bgInputRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef(null);
  const historyRef = useRef([]);

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
  }, []);

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

  // 4-way flood fill with a small tolerance for anti-aliased edges.
  const floodFill = (startX, startY) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const sx = Math.round(startX);
    const sy = Math.round(startY);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const at = (x, y) => (y * w + x) * 4;
    const start = at(sx, sy);
    const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    const [fr, fg, fb, fa] = hexToRgba(color);
    if (target[0] === fr && target[1] === fg && target[2] === fb && target[3] === fa) return;
    const tol = 32;
    const matches = (i) =>
      Math.abs(data[i] - target[0]) <= tol &&
      Math.abs(data[i + 1] - target[1]) <= tol &&
      Math.abs(data[i + 2] - target[2]) <= tol &&
      Math.abs(data[i + 3] - target[3]) <= tol;
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = at(x, y);
      if (!matches(i)) continue;
      data[i] = fr;
      data[i + 1] = fg;
      data[i + 2] = fb;
      data[i + 3] = fa;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    ctx.putImageData(img, 0, 0);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = pointFromEvent(e);
    if (tool === 'fill') {
      pushHistory();
      floodFill(p.x, p.y);
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
  };

  const endStroke = () => {
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

  return (
    <div
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            🖌 {t('paint.title')}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} aria-label={t('common.close')} style={{ ...toolBtn(false), padding: '0.3rem 0.6rem' }}>
            ×
          </button>
        </div>

        {/* Row 1: foreground colours + brush size + tools */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
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

          <div style={{ flex: 1 }} />

          <button style={toolBtn(tool === 'brush')} onClick={() => setTool('brush')}>🖌 {t('paint.brush')}</button>
          <button style={toolBtn(tool === 'fill')} onClick={() => setTool('fill')}>🪣 {t('paint.fill')}</button>
          <button style={toolBtn(tool === 'eraser')} onClick={() => setTool('eraser')}>🧽 {t('paint.eraser')}</button>
        </div>

        {/* Row 2: background controls + image + undo/clear */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('paint.bg')}</span>
          <input
            type="color"
            value={bgColor ?? '#ffffff'}
            onChange={(e) => setBgColor(e.target.value)}
            title={t('paint.bgColor')}
            style={{ width: 28, height: 28, padding: 0, border: 'none', background: 'none', cursor: 'pointer', opacity: transparent ? 0.4 : 1 }}
          />
          <button style={toolBtn(transparent)} onClick={() => setBgColor(transparent ? '#ffffff' : null)}>
            {t('paint.transparent')}
          </button>
          <button style={toolBtn(false)} onClick={() => bgInputRef.current?.click()}>🖼 {t('paint.image')}</button>

          <div style={{ flex: 1 }} />

          <button style={{ ...toolBtn(false), opacity: canUndo ? 1 : 0.4 }} onClick={undo} disabled={!canUndo} title={t('paint.undo')}>
            ↶ {t('paint.undo')}
          </button>
          <button style={toolBtn(false)} onClick={clear} title={t('paint.clear')}>🗑 {t('paint.clear')}</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', background: 'var(--input-bg)', borderRadius: '8px', padding: '0.5rem' }}>
          <canvas
            ref={canvasRef}
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
          <button onClick={onClose} style={toolBtn(false)}>{t('common.cancel')}</button>
          <button onClick={apply} className="btn-primary" style={{ ...toolBtn(true), padding: '0.5rem 1.1rem' }}>
            ✓ {t('paint.use')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DrawCanvas;
