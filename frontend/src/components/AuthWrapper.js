import React, { useState } from 'react';
import LoginPage from './LoginPage';
import LanguageSwitcher from './LanguageSwitcher';
import { useTranslation } from '../i18n/LanguageContext';

// Makes sure a user profile (name + avatar) exists before rendering the page.
// The profile is global: the same identity is used to browse, host and join
// games. Game-room connections are handled by GameProvider, not here.
const AuthWrapper = ({ children, showHeader = true }) => {
  const { t } = useTranslation();
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('user'));
    } catch (error) {
      localStorage.removeItem('user');
      return null;
    }
  });

  const handleLogin = (userData) => {
    setUser(userData);
  };

  const handleLogout = () => {
    localStorage.removeItem('user');
    setUser(null);
  };

  if (!user) {
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
          <LanguageSwitcher />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
            <span style={{ color: '#aaa' }}>{user.name}</span>
          </div>
          <button
            onClick={handleLogout}
            style={{
              padding: '0.5rem 1rem',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            {t('common.logout')}
          </button>
        </div>
      )}
      {React.cloneElement(children, { user })}
    </div>
  );
};

export default AuthWrapper;
