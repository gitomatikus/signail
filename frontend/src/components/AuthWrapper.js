import React, { useState } from 'react';
import LoginPage from './LoginPage';
import LanguageSwitcher from './LanguageSwitcher';
import EditProfileModal from './EditProfileModal';
import MicCheckSetting from './MicCheckSetting';
import { useTranslation } from '../i18n/LanguageContext';
import { THEMES, getTheme, applyTheme } from '../utils/theme';
import { getPlayerColor } from '../utils/playerIdentity';

// Makes sure a user profile (name + avatar) exists before rendering the page.
// The profile is global: the same identity is used to browse, host and join
// games. Game-room connections are handled by GameProvider, not here.
// Routes with requireAuth={false} render for anonymous visitors too: the page
// gets user=null and an onRequestLogin() callback that opens the login form
// as an overlay on top of the page.
const AuthWrapper = ({ children, showHeader = true, requireAuth = true }) => {
  const { t } = useTranslation();
  const [user, setUser] = useState(() => {
    try {
      const storedUser = JSON.parse(localStorage.getItem('user'));
      if (!storedUser) return null;
      const migratedUser = { ...storedUser, color: getPlayerColor(storedUser) };
      localStorage.setItem('user', JSON.stringify(migratedUser));
      return migratedUser;
    } catch (error) {
      localStorage.removeItem('user');
      return null;
    }
  });
  const [loginOpen, setLoginOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [theme, setTheme] = useState(() => getTheme());

  const handleThemeChange = (e) => {
    setTheme(e.target.value);
    applyTheme(e.target.value);
  };

  const handleLogin = (userData) => {
    setUser(userData);
    setLoginOpen(false);
  };

  const handleLogout = () => {
    localStorage.removeItem('user');
    setUser(null);
  };

  const handleUpdateUser = (updatedData) => {
    setUser((prevUser) => {
      if (!prevUser) return null;
      const newUser = { ...prevUser, ...updatedData };
      localStorage.setItem('user', JSON.stringify(newUser));
      return newUser;
    });
  };

  if (!user && requireAuth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div>
      {showHeader && (
        <div style={{
          position: 'fixed',
          top: 0,
          right: 0,
          padding: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          zIndex: 1000
        }}>
          <select
            value={theme}
            onChange={handleThemeChange}
            aria-label={t('settings.design')}
            title={t('settings.design')}
            style={{ width: 'auto', padding: '0.4rem 0.6rem', fontSize: '0.85rem', borderRadius: '8px' }}
          >
            {THEMES.map(option => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
          <LanguageSwitcher />
          {user && (
            <>
              <div
                onClick={() => setEditProfileOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  cursor: 'pointer',
                  padding: '0.3rem 0.6rem',
                  borderRadius: '8px',
                  background: 'var(--surface-soft)',
                  border: '1px solid var(--glass-border)',
                  transition: 'var(--transition-fast)'
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--primary)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--glass-border)'}
                title={t('profile.editTooltip')}
              >
                {user.imageUrl.toLowerCase().endsWith('.mp4') ? (
                  <video
                    src={user.imageUrl}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      objectFit: 'cover'
                    }}
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                ) : (
                  <img
                    src={user.imageUrl}
                    alt={user.name}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      objectFit: 'cover'
                    }}
                  />
                )}
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{user.name}</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>✏️</span>
              </div>
              <MicCheckSetting variant="compact" />
              <button
                onClick={handleLogout}
                className="btn-ghost"
                style={{ padding: '0.5rem 1rem' }}
              >
                {t('common.logout')}
              </button>
            </>
          )}
        </div>
      )}
      {React.cloneElement(children, { user, onUpdateUser: handleUpdateUser, onRequestLogin: () => setLoginOpen(true) })}
      {!user && loginOpen && (
        <LoginPage onLogin={handleLogin} onClose={() => setLoginOpen(false)} />
      )}
      {user && editProfileOpen && (
        <EditProfileModal
          user={user}
          onClose={() => setEditProfileOpen(false)}
          onSave={(data) => {
            handleUpdateUser(data);
            setEditProfileOpen(false);
          }}
        />
      )}
    </div>
  );
};

export default AuthWrapper;
