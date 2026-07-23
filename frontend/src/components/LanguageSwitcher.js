import React from 'react';
import { useTranslation } from '../i18n/LanguageContext';

// Compact EN | УКР toggle, styled to sit anywhere in the glass UI
const LanguageSwitcher = ({ style }) => {
  const { language, setLanguage, t } = useTranslation();

  const buttonStyle = (active) => ({
    padding: '0.35rem 0.75rem',
    background: active ? 'var(--primary)' : 'transparent',
    color: active ? 'var(--on-primary)' : 'var(--text-secondary)',
    border: 'none',
    borderRadius: '6px',
    cursor: active ? 'default' : 'pointer',
    fontSize: '0.8rem',
    fontWeight: 700,
    letterSpacing: '0.05em',
    transition: 'all 0.2s'
  });

  return (
    <div
      className="language-switcher"
      title={t('common.language')}
      style={{
        display: 'inline-flex',
        gap: '2px',
        padding: '2px',
        background: 'var(--surface-soft)',
        border: '1px solid var(--glass-border)',
        borderRadius: '8px',
        ...style
      }}
    >
      <button type="button" style={buttonStyle(language === 'en')} onClick={() => setLanguage('en')}>
        EN
      </button>
      <button type="button" style={buttonStyle(language === 'uk')} onClick={() => setLanguage('uk')}>
        УКР
      </button>
    </div>
  );
};

export default LanguageSwitcher;
