// Compresses an image Blob/File on the client so the resulting payload stays
// small enough to live inside the user object (localStorage + JSON API +
// WebSocket broadcasts, backend JSON body limit is 1mb).
//
// Images already under the byte budget pass through untouched, which keeps
// animated GIFs animated. Larger images are re-encoded (WebP when the browser
// can encode it, JPEG otherwise) on a descending dimension/quality ladder
// until they fit.

export const MAX_AVATAR_BYTES = 200 * 1024;

// True for inline image payloads like the ones compressImageToDataUrl produces
// (data:image/webp;base64,...). These are valid avatar sources but aren't
// "URLs" in the file-extension sense, so callers treat them like a pasted
// image (chip + preview) rather than running them through URL validation.
export const isImageDataUrl = (value) =>
  typeof value === 'string' && /^data:image\//i.test(value.trim());

// Approximate decoded size of a base64 data URL, for the "(N KB)" size label.
// Returns 0 for anything without a base64 payload.
export const dataUrlBytes = (dataUrl) => {
  if (typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
};

// {dim, quality} pairs tried in order; first result under the budget wins.
const ENCODE_LADDER = [
  { dim: 1024, quality: 0.85 },
  { dim: 1024, quality: 0.7 },
  { dim: 800, quality: 0.7 },
  { dim: 640, quality: 0.65 },
  { dim: 512, quality: 0.6 },
  { dim: 400, quality: 0.55 },
  { dim: 320, quality: 0.5 },
  { dim: 256, quality: 0.45 },
  { dim: 192, quality: 0.4 },
  { dim: 128, quality: 0.4 }
];

let webpSupported = null;
const canEncodeWebP = () => {
  if (webpSupported === null) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      webpSupported = false;
    }
  }
  return webpSupported;
};

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Failed to read image data'));
  reader.readAsDataURL(blob);
});

const loadImage = (blob) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    resolve(img);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('Failed to decode image'));
  };
  img.src = url;
});

const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode image'))),
    type,
    quality
  );
});

// Returns { dataUrl, bytes }. Throws if the blob can't be decoded or (in
// practice never) can't be squeezed under maxBytes.
export const compressImageToDataUrl = async (blob, maxBytes = MAX_AVATAR_BYTES) => {
  if (blob.size <= maxBytes) {
    return { dataUrl: await blobToDataUrl(blob), bytes: blob.size };
  }

  const img = await loadImage(blob);
  const type = canEncodeWebP() ? 'image/webp' : 'image/jpeg';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  for (const { dim, quality } of ENCODE_LADDER) {
    const scale = Math.min(1, dim / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));

    if (type === 'image/jpeg') {
      // JPEG has no alpha channel; fill so transparency doesn't turn black.
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const out = await canvasToBlob(canvas, type, quality);
    if (out.size <= maxBytes) {
      return { dataUrl: await blobToDataUrl(out), bytes: out.size };
    }
  }

  throw new Error('Could not compress image under the size limit');
};
