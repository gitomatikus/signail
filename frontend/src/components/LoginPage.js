import React, { useRef, useState } from 'react';
import { useTranslation } from '../i18n/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import Logo from './Logo';
import { compressImageToDataUrl, isImageDataUrl, dataUrlBytes } from '../utils/compressImage';
import { getPlayerColor } from '../utils/playerIdentity';

// Standalone full-screen login by default; pass onClose to render it as a
// dismissable overlay on top of the current page (backdrop click / × close).
const LoginPage = ({ onLogin, onClose }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [pastedImage, setPastedImage] = useState(null); // { dataUrl, bytes }
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  const validateImageUrl = (url) => {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.webp'];
    return validExtensions.some(ext => url.toLowerCase().endsWith(ext));
  };

  // A data URL pasted as text (rather than as a file) becomes a pasted image
  // too, so it gets the real preview + chip and skips URL-extension validation.
  const handleImageUrlChange = (value) => {
    if (isImageDataUrl(value)) {
      const trimmed = value.trim();
      setPastedImage({ dataUrl: trimmed, bytes: dataUrlBytes(trimmed) });
      setImageUrl('');
    } else {
      setImageUrl(value);
    }
  };

  // Device uploads and clipboard images share the exact same compression and
  // Base64 data-URL path, so the stored user object keeps one avatar format.
  const processImageFile = async (file, source) => {
    setProcessing(true);
    setError('');
    try {
      const image = await compressImageToDataUrl(file);
      setPastedImage({ ...image, source });
      setImageUrl('');
    } catch {
      setError(source === 'upload' ? 'login.errorUploadFailed' : 'login.errorPasteFailed');
    } finally {
      setProcessing(false);
    }
  };

  // Catches image pastes anywhere in the form; text pastes fall through to
  // the focused input untouched.
  const handlePaste = async (e) => {
    const item = Array.from(e.clipboardData?.items || [])
      .find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;

    e.preventDefault();
    const file = item.getAsFile();
    if (file) await processImageFile(file, 'paste');
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    // Let the same file be selected again after it has been removed.
    e.target.value = '';
    if (file) await processImageFile(file, 'upload');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('login.errorName');
      return;
    }

    if (!pastedImage) {
      if (!imageUrl.trim()) {
        setError('login.errorImage');
        return;
      }

      if (!validateImageUrl(imageUrl)) {
        setError('login.errorImageInvalid');
        return;
      }
    }

    const id = `${name.trim()}-${Date.now()}`;
    const userData = {
      id,
      name: name.trim(),
      imageUrl: pastedImage ? pastedImage.dataUrl : imageUrl.trim(),
      color: getPlayerColor({ id }),
      lastLogin: new Date().toISOString(),
      score: 0
    };

    localStorage.setItem('user', JSON.stringify(userData));
    onLogin(userData);
  };

  const previewSrc = pastedImage ? pastedImage.dataUrl
    : (imageUrl && validateImageUrl(imageUrl)) ? imageUrl : null;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        padding: '1rem',
        ...(onClose ? {
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(5px)',
          overflowY: 'auto',
          zIndex: 99999
        } : {})
      }}
      onClick={onClose}
    >
      <div className="glass-panel fade-in" style={{
        padding: '2.5rem',
        width: '100%',
        maxWidth: '420px',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        position: 'relative'
      }} onClick={e => e.stopPropagation()} onPaste={handlePaste}>
        {onClose && (
          <button
            type="button"
            className="login-close-button"
            onClick={onClose}
            aria-label={t('common.close')}
            style={{
              position: 'absolute',
              top: '1rem',
              left: '1rem',
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: '1.5rem',
              lineHeight: 1,
              padding: 0,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        )}
        <LanguageSwitcher style={{ position: 'absolute', top: '1rem', right: '1rem' }} />
        <div style={{ textAlign: 'center' }}>
          <Logo fontSize="2.5rem" style={{ marginBottom: '0.5rem' }} />
          <p style={{ color: 'var(--text-secondary)' }}>{t('login.tagline')}</p>
        </div>

        {error && (
          <div style={{
            color: '#ef4444',
            padding: '0.75rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '8px',
            fontSize: '0.875rem',
            textAlign: 'center'
          }}>
            {t(error)}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {t('login.playerName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('login.namePlaceholder')}
              autoFocus
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                {t('login.avatarUrl')}
              </label>
              <a
                href="https://giphy.com"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '0.875rem' }}
              >
                {t('login.findGif')}
              </a>
            </div>

            {pastedImage ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
                padding: '0.6rem 0.75rem',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--primary)',
                borderRadius: '8px',
                fontSize: '0.875rem'
              }}>
                <span>
                  {t(pastedImage.source === 'upload' ? 'login.uploadedImage' : 'login.pastedImage')}
                  {' '}({Math.round(pastedImage.bytes / 1024)} KB)
                </span>
                <button
                  type="button"
                  onClick={() => setPastedImage(null)}
                  aria-label={t('login.removeImage')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: '1.1rem',
                    lineHeight: 1,
                    padding: 0,
                    cursor: 'pointer'
                  }}
                >
                  ×
                </button>
              </div>
            ) : (
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => handleImageUrlChange(e.target.value)}
                placeholder={t('login.avatarPlaceholder')}
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
              disabled={processing}
              aria-label={t('login.uploadAvatar')}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={processing}
              style={{
                width: '100%',
                minHeight: '44px',
                marginTop: '0.65rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.55rem'
              }}
            >
              <span aria-hidden="true">↑</span>
              {processing ? t('login.processingImage') : t('login.uploadAvatar')}
            </button>
            <div style={{ marginTop: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
              {t('login.pasteHint')}
            </div>
          </div>

          {previewSrc && (
            <div style={{
              width: '100px',
              height: '100px',
              margin: '0 auto',
              borderRadius: '50%',
              border: '2px solid var(--primary)',
              padding: '2px',
              background: 'var(--bg-dark)',
              overflow: 'hidden',
              position: 'relative'
            }}>
              {previewSrc.toLowerCase().endsWith('.mp4') ? (
                <video
                  src={previewSrc}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
                  autoPlay loop muted playsInline
                />
              ) : (
                <img
                  src={previewSrc}
                  alt="preview"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
                  onError={e => { e.target.style.display = 'none'; }}
                />
              )}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary"
            disabled={processing}
            style={{ width: '100%', marginTop: '0.5rem' }}
          >
            {t('login.join')}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
