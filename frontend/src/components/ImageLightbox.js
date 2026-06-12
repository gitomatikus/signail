import React, { useEffect, useRef, useState } from 'react';

// Fullscreen popup showing an image at its natural (100%) size, scrollable
// when it exceeds the viewport. The mouse wheel and the −/+ buttons zoom
// (the % button resets). Click anywhere or press Escape to close.
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const SCALE_STEP = 1.25;

const ImageLightbox = ({ src, onClose }) => {
  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const [scale, setScale] = useState(1);
  // Zoom resizes the element itself (width = natural × scale) instead of a
  // CSS transform: transforms don't grow the scroll area, so a transformed
  // image couldn't be panned by scrolling
  const [naturalWidth, setNaturalWidth] = useState(null);

  useEffect(() => {
    setScale(1);
    setNaturalWidth(null);
  }, [src]);

  // Instantly-cached images may be complete before onLoad is attached
  useEffect(() => {
    const img = imgRef.current;
    if (src && img && img.complete && img.naturalWidth) {
      setNaturalWidth(img.naturalWidth);
    }
  }, [src]);

  useEffect(() => {
    if (!src) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [src, onClose]);

  // Native non-passive listener: React's onWheel registers passively on some
  // setups and then preventDefault (needed to stop the scroll) is ignored
  useEffect(() => {
    if (!src) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
      setScale(s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [src]);

  if (!src) return null;

  const zoomBy = (factor) =>
    setScale(s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));

  const controlStyle = {
    minWidth: '44px',
    height: '44px',
    padding: '0 0.75rem',
    borderRadius: '22px',
    background: 'rgba(255, 255, 255, 0.12)',
    color: '#fff',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    fontSize: '1.25rem',
    fontWeight: 'bold',
    cursor: 'pointer',
    lineHeight: 1
  };

  return (
    <div
      ref={containerRef}
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0, 0, 0, 0.88)',
        zIndex: 3000,
        display: 'flex',
        cursor: 'zoom-out',
        overflow: 'auto',
        padding: '2rem',
        boxSizing: 'border-box'
      }}
    >
      {/* margin auto centers a small image and keeps a large one scrollable */}
      <img
        ref={imgRef}
        src={src}
        alt=""
        onLoad={(e) => setNaturalWidth(e.target.naturalWidth)}
        style={{
          margin: 'auto',
          maxWidth: 'none',
          width: naturalWidth ? `${Math.max(1, Math.round(naturalWidth * scale))}px` : 'auto',
          height: 'auto',
          borderRadius: '8px',
          boxShadow: '0 12px 48px rgba(0, 0, 0, 0.8)'
        }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '1rem',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'center',
          cursor: 'default'
        }}
      >
        <button aria-label="Zoom out" onClick={() => zoomBy(1 / SCALE_STEP)} style={controlStyle}>
          −
        </button>
        <button
          aria-label="Reset zoom"
          onClick={() => setScale(1)}
          style={{ ...controlStyle, fontSize: '0.9rem', fontVariantNumeric: 'tabular-nums' }}
        >
          {Math.round(scale * 100)}%
        </button>
        <button aria-label="Zoom in" onClick={() => zoomBy(SCALE_STEP)} style={controlStyle}>
          +
        </button>
      </div>
      <button
        onClick={onClose}
        style={{
          position: 'fixed',
          top: '1rem',
          right: '1.5rem',
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          background: 'rgba(255, 255, 255, 0.12)',
          color: '#fff',
          border: '1px solid rgba(255, 255, 255, 0.25)',
          fontSize: '1.5rem',
          fontWeight: 'bold',
          cursor: 'pointer',
          lineHeight: 1
        }}
      >
        ×
      </button>
    </div>
  );
};

export default ImageLightbox;
