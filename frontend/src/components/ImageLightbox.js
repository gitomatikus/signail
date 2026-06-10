import React, { useEffect } from 'react';

// Fullscreen popup showing an image at its natural (100%) size, scrollable
// when it exceeds the viewport. Click anywhere or press Escape to close.
const ImageLightbox = ({ src, onClose }) => {
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

  if (!src) return null;

  return (
    <div
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
        src={src}
        alt=""
        style={{
          margin: 'auto',
          maxWidth: 'none',
          borderRadius: '8px',
          boxShadow: '0 12px 48px rgba(0, 0, 0, 0.8)'
        }}
      />
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
