import React, { useCallback, useEffect, useRef, useState } from 'react';
import SpectrumQuestion from '../components/SpectrumQuestion';
import OnlineUsers from '../components/OnlineUsers';
import Settings from '../components/Settings';
import Logo from '../components/Logo';
import wsManager from '../utils/websocket';
import { useGame } from '../contexts/GameContext';
import { useTranslation } from '../i18n/LanguageContext';

const createEmptyMeta = () => ({
  questionId: null,
  clueGiverId: null,
  answererIds: [],
  suggestions: {},
  multipliers: {},
  revealed: false,
});

const SpectrogramPage = () => {
  const { t } = useTranslation();
  const { isHost, onlineUsers, user, gameInfo } = useGame();
  const [round, setRound] = useState(null);
  const [meta, setMeta] = useState(createEmptyMeta);
  const activeQuestionIdRef = useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const handleMeta = useCallback(next => {
    if (Number(next?.questionId) !== Number(activeQuestionIdRef.current)) return;
    setMeta(next);
  }, []);

  useEffect(() => {
    const unsubscribe = wsManager.subscribe(message => {
      if (message.type === 'ws_open') {
        wsManager.sendSpectrogramSync();
      } else if (message.type === 'spectrogram_round') {
        activeQuestionIdRef.current = message.data?.question?.id ?? null;
        setRound(message.data);
        setMeta(createEmptyMeta());
      }
    });
    wsManager.sendSpectrogramSync();
    return unsubscribe;
  }, []);

  if (!round?.question) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>
        {t('spectrogram.preparing')}
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ minHeight: '100vh', width: '100%', padding: '1.25rem', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <header style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: '1rem' }}>
          <button className="glass-panel" onClick={() => setSettingsOpen(true)} style={{ justifySelf: 'start', padding: '.65rem 1rem', color: 'var(--text-secondary)', border: '1px solid var(--glass-border)', cursor: 'pointer' }}>
            ⚙️ {t('common.settings')}
          </button>
          <div style={{ textAlign: 'center' }}>
            <Logo />
            <div style={{ color: 'var(--accent)', fontWeight: 800, marginTop: '.35rem' }}>
              {t('spectrogram.round', { number: round.number })} · {gameInfo.spectrogramClueMode === 'verbal' ? t('spectrogram.verbalShort') : t('spectrogram.textShort')}
            </div>
          </div>
          <div />
        </header>

        <SpectrumQuestion
          key={round.question.id}
          question={round.question}
          currentUserId={user?.id || null}
          isAdmin={isHost}
          onlineUsers={onlineUsers}
          onMetaChange={handleMeta}
        />

        {isHost && meta.revealed && (
          <div className="glass-panel" style={{ alignSelf: 'center', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{t('spectrogram.applyHint')}</span>
            <button className="btn-primary" onClick={() => wsManager.sendSpectrogramNext()}>
              {t('spectrogram.next')}
            </button>
          </div>
        )}

        <OnlineUsers
          key={`players-${round.question.id}`}
          users={onlineUsers}
          currentUserId={user?.id || null}
          isAdmin={isHost}
          question={round.question}
          selectedTargetId={meta.clueGiverId}
          spectrumAnswererIds={meta.answererIds}
          spectrumSuggestions={meta.suggestions}
          spectrumMultipliers={meta.multipliers}
        />
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} isAdmin={isHost} />}
    </div>
  );
};

export default SpectrogramPage;
