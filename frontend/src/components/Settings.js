import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { indexedDBService } from '../services/indexedDB';
import wsManager from '../utils/websocket';
import { useGame } from '../contexts/GameContext';
import { isHostHidden, setHostHidden } from '../utils/hostVisibility';
import { getHostToken, removeHostToken } from '../services/gameAuth';
import config from '../config';
import { useTranslation } from '../i18n/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';

const Settings = ({ onClose, isAdmin = false }) => {
  const { gameId, gameInfo } = useGame() || {};
  const navigate = useNavigate();
  const { t, translateMessage } = useTranslation();
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [isClearingPack, setIsClearingPack] = useState(false);
  // message: { text, isError } — text is a translation key or a server message
  const [message, setMessage] = useState(null);
  const [hideHost, setHideHost] = useState(() => isHostHidden());
  const [passwordInput, setPasswordInput] = useState('');
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const handleClearCache = async () => {
    try {
      setIsClearingCache(true);
      setMessage(null);
      wsManager.sendClearCache();
      setMessage({ text: t('settings.cacheCleared'), isError: false });
    } catch (error) {
      setMessage({ text: t('settings.errorClearingCache', { message: translateMessage(error.message) }), isError: true });
    } finally {
      setIsClearingCache(false);
    }
  };

  const handleClearPack = async () => {
    try {
      setIsClearingPack(true);
      setMessage(null);
      await indexedDBService.deletePack(`pack-${gameId}`);
      setMessage({ text: t('settings.packCleared'), isError: false });
    } catch (error) {
      setMessage({ text: t('settings.errorClearingPack', { message: translateMessage(error.message) }), isError: true });
    } finally {
      setIsClearingPack(false);
    }
  };

  const handleToggleHideHost = () => {
    const next = !hideHost;
    setHideHost(next);
    setHostHidden(next);
  };

  // Leaving just disconnects: GameProvider tears the socket down on unmount
  // and the server drops the player from the room
  const handleExitGame = () => {
    navigate('/');
  };

  const handleSavePassword = async () => {
    try {
      setIsSavingPassword(true);
      setMessage(null);
      const response = await fetch(`${config.apiUrl}/api/games/${gameId}/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Host-Token': getHostToken(gameId)
        },
        body: JSON.stringify({ password: passwordInput })
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || t('settings.failedUpdatePassword'));
      }
      setMessage({ text: result.data.hasPassword ? t('settings.passwordSetMsg') : t('settings.passwordRemovedMsg'), isError: false });
      setPasswordInput('');
    } catch (error) {
      setMessage({ text: t('settings.errorUpdatingPassword', { message: translateMessage(error.message) }), isError: true });
    } finally {
      setIsSavingPassword(false);
    }
  };

  const handleExitAndDelete = async () => {
    if (!window.confirm(t('settings.deleteEveryoneConfirm'))) return;
    try {
      const response = await fetch(`${config.apiUrl}/api/games/${gameId}`, {
        method: 'DELETE',
        headers: { 'X-Host-Token': getHostToken(gameId) }
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.message || t('settings.failedDeleteGame'));
      }
      removeHostToken(gameId);
      navigate('/');
    } catch (error) {
      setMessage({ text: t('settings.errorDeletingGame', { message: translateMessage(error.message) }), isError: true });
    }
  };

  const modalContent = (
    <div className="fade-in" style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0, 0, 0, 0.7)',
      backdropFilter: 'blur(5px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 99999 // Ensure it's on top of everything
    }} onClick={onClose}>
      <div
        className="glass-panel"
        style={{
          padding: '2rem',
          borderRadius: '16px',
          minWidth: '320px',
          maxWidth: '500px',
          width: '90%',
          border: '1px solid var(--glass-border)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-gradient" style={{
          marginTop: 0,
          marginBottom: '1.5rem',
          fontSize: '2rem',
          textAlign: 'center'
        }}>{t('settings.title')}</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid var(--glass-border)',
            borderRadius: '8px',
            color: 'var(--text-primary)'
          }}>
            <span>{t('common.language')}</span>
            <LanguageSwitcher />
          </div>

          {isAdmin && (
            <button
              onClick={handleClearCache}
              disabled={isClearingCache}
              className="btn-primary"
              style={{
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                boxShadow: '0 0 15px rgba(239, 68, 68, 0.4)',
                width: '100%'
              }}
            >
              {isClearingCache ? t('settings.clearing') : t('settings.clearCache')}
            </button>
          )}

          <button
            onClick={handleClearPack}
            disabled={isClearingPack}
            className="btn-primary"
            style={{
              background: 'linear-gradient(135deg, #f59e0b, #d97706)',
              boxShadow: '0 0 15px rgba(245, 158, 11, 0.4)',
              width: '100%'
            }}
          >
            {isClearingPack ? t('settings.clearing') : t('settings.clearPack')}
          </button>

          {!isAdmin && (
            <label style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              padding: '0.75rem 1rem',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--glass-border)',
              borderRadius: '8px',
              color: 'var(--text-primary)',
              cursor: 'pointer'
            }}>
              <span>{t('settings.hideHost')}</span>
              <input
                type="checkbox"
                checked={hideHost}
                onChange={handleToggleHideHost}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
            </label>
          )}

          {isAdmin && gameId && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              padding: '0.75rem 1rem',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--glass-border)',
              borderRadius: '8px'
            }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                {t('settings.gamePassword')} {gameInfo?.hasPassword ? t('settings.passwordSet') : t('settings.passwordNone')}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={passwordInput}
                  onChange={e => setPasswordInput(e.target.value)}
                  placeholder={t('settings.newPasswordPlaceholder')}
                  style={{ flex: 1 }}
                />
                <button
                  onClick={handleSavePassword}
                  disabled={isSavingPassword}
                  className="btn-primary"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {isSavingPassword ? t('settings.saving') : t('settings.save')}
                </button>
              </div>
            </div>
          )}

          {gameId && (
            <button
              onClick={handleExitGame}
              className="btn-primary"
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                color: 'var(--text-primary)',
                boxShadow: 'none',
                border: '1px solid var(--glass-border)',
                width: '100%'
              }}
            >
              {t('settings.exitGame')}
            </button>
          )}

          {isAdmin && gameId && (
            <button
              onClick={handleExitAndDelete}
              className="btn-primary"
              style={{
                background: 'linear-gradient(135deg, #ef4444, #991b1b)',
                boxShadow: '0 0 15px rgba(239, 68, 68, 0.4)',
                width: '100%'
              }}
            >
              {t('settings.exitDelete')}
            </button>
          )}

          {message && (
            <div style={{
              padding: '0.75rem',
              borderRadius: '8px',
              background: message.isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
              border: `1px solid ${message.isError ? '#ef4444' : '#22c55e'}`,
              color: message.isError ? '#ef4444' : '#22c55e',
              textAlign: 'center',
              fontSize: '0.9rem'
            }}>
              {message.text}
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          style={{
            marginTop: '2rem',
            width: '100%',
            padding: '0.75rem',
            background: 'rgba(255, 255, 255, 0.1)',
            color: 'var(--text-primary)',
            border: '1px solid var(--glass-border)',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '1rem',
            transition: 'all 0.2s'
          }}
          onMouseEnter={e => {
            e.target.style.background = 'rgba(255, 255, 255, 0.2)';
          }}
          onMouseLeave={e => {
            e.target.style.background = 'rgba(255, 255, 255, 0.1)';
          }}
        >
          {t('common.close')}
        </button>
      </div>
    </div>
  );

  return ReactDOM.createPortal(modalContent, document.body);
};

export default Settings;
