import React, { createContext, useContext, useMemo, useState } from 'react';
import { translations, serverMessages, serverMessagePrefixes } from './translations';

const LANGUAGE_KEY = 'signail:language';

const LanguageContext = createContext(null);

const detectLanguage = () => {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (saved === 'en' || saved === 'uk') return saved;
  const browser = (navigator.language || '').toLowerCase();
  return browser.startsWith('uk') || browser.startsWith('ru') ? 'uk' : 'en';
};

const interpolate = (template, params) => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] !== undefined ? String(params[name]) : match
  );
};

// Plural form index: en has [one, many], uk has [one, few, many]
const pluralIndex = (language, count) => {
  const n = Math.abs(count);
  if (language === 'uk') {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 0;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1;
    return 2;
  }
  return n === 1 ? 0 : 1;
};

export const LanguageProvider = ({ children }) => {
  const [language, setLanguageState] = useState(detectLanguage);

  const value = useMemo(() => {
    const setLanguage = (lang) => {
      localStorage.setItem(LANGUAGE_KEY, lang);
      setLanguageState(lang);
    };

    const lookup = (key) => translations[language][key] ?? translations.en[key] ?? key;

    const t = (key, params) => {
      const entry = lookup(key);
      return typeof entry === 'string' ? interpolate(entry, params) : key;
    };

    // Plural-aware variant: the entry is an array of forms, picked by count
    const tp = (key, count, params) => {
      const entry = lookup(key);
      if (!Array.isArray(entry)) return t(key, { count, ...params });
      const form = entry[Math.min(pluralIndex(language, count), entry.length - 1)];
      return interpolate(form, { count, ...params });
    };

    // Error state may hold a translation key, a raw English server message,
    // or free text — resolve in that order
    const translateMessage = (message) => {
      if (!message) return message;
      const viaKey = lookup(message);
      if (viaKey !== message) {
        return typeof viaKey === 'string' ? viaKey : message;
      }
      if (language === 'uk') {
        if (serverMessages[message]) return serverMessages[message];
        for (const [prefix, replacement] of Object.entries(serverMessagePrefixes)) {
          if (message.startsWith(prefix)) {
            return replacement + message.slice(prefix.length);
          }
        }
      }
      return message;
    };

    return { language, setLanguage, t, tp, translateMessage };
  }, [language]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useTranslation = () => useContext(LanguageContext);
