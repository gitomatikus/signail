import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from '../i18n/LanguageContext';
import { compressImageToDataUrl } from '../utils/compressImage';

const EditProfileModal = ({ user, onSave, onClose }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(user?.name || '');
  const [imageUrl, setImageUrl] = useState(user?.imageUrl || '');
  const [pastedImage, setPastedImage] = useState(null); // { dataUrl, bytes }
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const validateImageUrl = (url) => {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.webp'];
    return validExtensions.some(ext => url.toLowerCase().endsWith(ext));
  };

  const handlePaste = async (e) => {
    const item = Array.from(e.clipboardData?.items || [])
      .find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;

    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;

    setProcessing(true);
    setError('');
    try {
      setPastedImage(await compressImageToDataUrl(file));
    } catch {
      setError('login.errorPasteFailed');
    } finally {
      setProcessing(false);
    }
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

    onSave({
      name: name.trim(),
      imageUrl: pastedImage ? pastedImage.dataUrl : imageUrl.trim(),
    });
  };

  const previewSrc = pastedImage ? pastedImage.dataUrl
    : (imageUrl && validateImageUrl(imageUrl)) ? imageUrl : null;

  const modalContent = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(5px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '1rem',
        overflowY: 'auto',
        zIndex: 99999
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
        <button
          type="button"
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
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '1.75rem' }}>{t('profile.editTitle')}</h2>
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
                  {t('login.pastedImage')} ({Math.round(pastedImage.bytes / 1024)} KB)
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
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder={t('login.avatarPlaceholder')}
              />
            )}
            <div style={{ marginTop: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
              {processing ? t('login.processingImage') : t('login.pasteHint')}
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

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="btn-ghost"
              style={{ flex: 1 }}
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn-primary"
              style={{ flex: 1 }}
              disabled={processing}
            >
              {t('profile.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

export default EditProfileModal;
