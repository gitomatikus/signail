// Shared canvas drawing primitives.
//
// Used by the one-shot paint modal (DrawCanvas) and by the live crocodile
// "draw" mode (CrocodileDrawing), where the performer's strokes are streamed
// as normalized ops and replayed identically on every guesser's canvas.
//
// An "op" is the wire unit of a drawing (see backend drawing_stroke handler):
//   { op:'begin', id, tool:'brush'|'eraser', color, size, x, y }
//   { op:'points', id, pts:[x0,y0,x1,y1,...] }   // flat, normalized 0..1
//   { op:'end', id }
//   { op:'fill', color, x, y }
//   { op:'undo' }   { op:'clear' }
// Coordinates and brush size are normalized 0..1 against the canvas so any
// canvas size renders the same picture; `createReplay` denormalizes on draw.

// Logical drawing resolution shared by performer and guesser canvases.
export const DRAW_W = 720;
export const DRAW_H = 420;

export const PALETTE = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];

export const hexToRgba = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
};

// 4-way flood fill with a small tolerance for anti-aliased edges. Operates on
// the whole canvas; the caller sets globalCompositeOperation to 'source-over'.
export const floodFill = (ctx, hexColor, startX, startY) => {
  const canvas = ctx.canvas;
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
  const [fr, fg, fb, fa] = hexToRgba(hexColor);
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

// Map a pointer event to normalized 0..1 canvas coordinates.
export const pointerToNorm = (e, canvas) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
};

// A replay controller bound to a 2D context. `apply(op)` renders one op and is
// the single rendering primitive for BOTH the performer's local canvas and the
// guessers' watch canvas, so they stay pixel-identical. Keeps a snapshot
// history so `undo` ops replay deterministically.
export function createReplay(ctx) {
  const canvas = ctx.canvas;
  const w = () => canvas.width;
  const h = () => canvas.height;
  const history = [];
  const strokes = new Map(); // strokeId -> { last:{x,y}, color, size, tool }

  const pushHistory = () => {
    history.push(ctx.getImageData(0, 0, w(), h()));
    if (history.length > 40) history.shift();
  };
  const denX = (x) => x * w();
  const denY = (y) => y * h();
  const denSize = (s) => Math.max(1, s * w());

  const apply = (op) => {
    if (!op || typeof op !== 'object') return;
    switch (op.op) {
      case 'begin': {
        pushHistory();
        const x = denX(op.x);
        const y = denY(op.y);
        const size = denSize(op.size);
        strokes.set(op.id, { last: { x, y }, color: op.color, size, tool: op.tool });
        ctx.globalCompositeOperation = op.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.beginPath();
        ctx.fillStyle = op.color;
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'points': {
        const st = strokes.get(op.id);
        const pts = op.pts;
        if (!st || !Array.isArray(pts)) break;
        ctx.globalCompositeOperation = st.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = st.color;
        ctx.lineWidth = st.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const x = denX(pts[i]);
          const y = denY(pts[i + 1]);
          ctx.beginPath();
          ctx.moveTo(st.last.x, st.last.y);
          ctx.lineTo(x, y);
          ctx.stroke();
          st.last = { x, y };
        }
        break;
      }
      case 'end':
        strokes.delete(op.id);
        ctx.globalCompositeOperation = 'source-over';
        break;
      case 'fill':
        pushHistory();
        ctx.globalCompositeOperation = 'source-over';
        floodFill(ctx, op.color, denX(op.x), denY(op.y));
        break;
      case 'undo': {
        const prev = history.pop();
        if (prev) ctx.putImageData(prev, 0, 0);
        break;
      }
      case 'clear':
        pushHistory();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, w(), h());
        break;
      default:
        break;
    }
  };

  const reset = () => {
    history.length = 0;
    strokes.clear();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w(), h());
  };

  const canUndo = () => history.length > 0;

  return { apply, reset, canUndo };
}
