import React, { useState, useEffect, useRef } from 'react';

// Renders an image hidden by the chosen effect; progress 0 = fully hidden,
// progress 1 = fully revealed. Effects: blur (default), pixelate, zoom.
const ProgressiveImage = ({ src, effect = 'blur', progress = 0 }) => {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const hidden = Math.max(0, Math.min(1, 1 - progress));

  useEffect(() => {
    if (effect !== 'pixelate') return;
    setLoaded(false);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      setLoaded(true);
    };
    // Retry without crossOrigin for servers that reject CORS requests;
    // drawing still works, the canvas is just tainted (we never read it back)
    img.onerror = () => {
      const plain = new Image();
      plain.onload = () => {
        imgRef.current = plain;
        setLoaded(true);
      };
      plain.src = src;
    };
    img.src = src;
  }, [src, effect]);

  useEffect(() => {
    if (effect !== 'pixelate' || !loaded || !canvasRef.current || !imgRef.current) return;
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    const pixelSize = Math.max(1, Math.ceil(hidden * Math.max(w, h) / 16));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w / pixelSize));
    tmp.height = Math.max(1, Math.round(h / pixelSize));
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.drawImage(img, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, w, h);
  }, [effect, loaded, hidden]);

  if (effect === 'pixelate') {
    return (
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
    );
  }

  if (effect === 'zoom') {
    return (
      <div style={{ overflow: 'hidden' }}>
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            userSelect: 'none',
            pointerEvents: 'none',
            transform: `scale(${1 + hidden * 7})`,
            transformOrigin: 'center center',
            transition: 'transform 1s linear'
          }}
        />
      </div>
    );
  }

  // blur (default)
  return (
    <div style={{ overflow: 'hidden' }}>
      <img
        src={src}
        alt=""
        draggable={false}
        style={{
          display: 'block',
          width: '100%',
          height: 'auto',
          userSelect: 'none',
          pointerEvents: 'none',
          filter: `blur(${Math.round(hidden * 40)}px)`,
          // Slightly oversize to hide transparent blur edges
          transform: `scale(${1 + hidden * 0.1})`,
          transition: 'filter 1s linear, transform 1s linear'
        }}
      />
    </div>
  );
};

export default ProgressiveImage;
