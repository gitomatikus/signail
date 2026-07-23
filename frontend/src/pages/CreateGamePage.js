import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../config';
import { saveHostToken } from '../services/gameAuth';
import { applyCacheKey } from '../services/cacheVersion';
import { indexedDBService } from '../services/indexedDB';
import { useTranslation } from '../i18n/LanguageContext';

// Creates a game: registers it (host identity + optional password), then
// streams the selected pack file to the server. The pack file is uploaded
// as-is - the server validates it and stores it on disk.
const CreateGamePage = ({ user }) => {
    const { t, translateMessage } = useTranslation();
    const [gameMode, setGameMode] = useState('quiz');
    const [spectrogramClueMode, setSpectrogramClueMode] = useState('text');
    const [file, setFile] = useState(null);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [uploadProgress, setUploadProgress] = useState(0);
    const [isUploading, setIsUploading] = useState(false);
    const navigate = useNavigate();

    const handleFileChange = (event) => {
        const selectedFile = event.target.files[0];
        if (selectedFile && (selectedFile.type === 'application/json' || selectedFile.name.endsWith('.json'))) {
            setFile(selectedFile);
            setError('');
            setUploadProgress(0);
        } else {
            setError('create.invalidJson');
            setFile(null);
            setUploadProgress(0);
        }
    };

    // Cloudflare caps a single request body at 100MB, so the pack is sliced
    // into sub-100MB chunks uploaded sequentially. Each chunk is its own
    // request tagged with its index; the server appends them and validates
    // once the last one lands. Small packs are a single chunk.
    const CHUNK_SIZE = 90 * 1024 * 1024;

    const sendChunk = (gameId, hostToken, index, chunkCount) => new Promise((resolve, reject) => {
        const start = index * CHUNK_SIZE;
        const blob = file.slice(start, start + CHUNK_SIZE);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${config.apiUrl}/api/games/${gameId}/pack`, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Host-Token', hostToken);
        xhr.setRequestHeader('X-Chunk-Index', index);
        xhr.setRequestHeader('X-Chunk-Count', chunkCount);

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                // Aggregate progress: bytes from finished chunks + this chunk's.
                setUploadProgress(Math.round(((start + event.loaded) * 100) / file.size));
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                try {
                    resolve(JSON.parse(xhr.responseText).data || {});
                } catch (e) {
                    reject(new Error('create.uploadFailed'));
                }
            } else {
                let message = 'create.uploadFailed';
                try {
                    message = JSON.parse(xhr.responseText).message || message;
                } catch (e) { /* non-JSON error body */ }
                reject(new Error(message));
            }
        };
        xhr.onerror = () => reject(new Error('create.networkError'));
        // Send the raw chunk: the browser streams it, the server pipes it to disk
        xhr.send(blob);
    });

    const uploadPack = async (gameId, hostToken) => {
        const chunkCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
        let last = {};
        for (let index = 0; index < chunkCount; index++) {
            // Sequential so the server appends chunks in order; the final
            // chunk's response carries packName/cacheKey.
            last = await sendChunk(gameId, hostToken, index, chunkCount);
        }
        return last;
    };

    const cacheUploadedPack = async (gameId, cacheKey) => {
        try {
            await applyCacheKey(gameId, cacheKey);
            const pack = JSON.parse(await file.text());
            await indexedDBService.savePack({ ...pack, id: `pack-${gameId}` });
        } catch (error) {
            // The upload already succeeded. Let GameContext download the pack
            // from the server if local parsing or IndexedDB storage fails.
            console.warn('Could not cache uploaded pack locally:', error);
        }
    };

    const handleCreate = async () => {
        if (gameMode === 'quiz' && !file) {
            setError('create.noFile');
            return;
        }
        setIsUploading(true);
        setUploadProgress(0);
        setError('');

        let created = null;
        try {
            const response = await fetch(`${config.apiUrl}/api/games`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    hostName: user?.name || 'Host',
                    hostImageUrl: user?.imageUrl || '',
                    hostColor: user?.color || '',
                    password: password || null,
                    mode: gameMode,
                    spectrogramClueMode
                })
            });
            const result = await response.json();
            if (result.status !== 'success') {
                throw new Error(result.message || 'create.createFailed');
            }
            created = result.data;
            saveHostToken(created.gameId, created.hostToken);

            if (gameMode === 'quiz') {
                const uploaded = await uploadPack(created.gameId, created.hostToken);
                await cacheUploadedPack(created.gameId, uploaded.cacheKey);
            }
            navigate(`/game/${created.gameId}`);
        } catch (err) {
            setError(err.message);
            setIsUploading(false);
            // The empty game would only clutter the list - clean it up
            if (created) {
                fetch(`${config.apiUrl}/api/games/${created.gameId}`, {
                    method: 'DELETE',
                    headers: { 'X-Host-Token': created.hostToken }
                }).catch(() => {});
            }
        }
    };

    return (
        <div className="fade-in mobile-page create-game-page" style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem'
        }}>
            <div className="glass-panel create-game-panel" style={{
                padding: '3rem',
                width: '100%',
                maxWidth: '600px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2rem'
            }}>
                <button
                    onClick={() => navigate('/')}
                    className="btn-ghost"
                    style={{ alignSelf: 'flex-start' }}
                >
                    {t('create.back')}
                </button>

                <h1 className="create-game-title" style={{
                    fontSize: '3rem',
                    fontWeight: '800',
                    margin: 0,
                    textAlign: 'center'
                }}>
                    {t('create.title')}
                </h1>

                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1.5rem'
                }}>
                    <div className="create-mode-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem', padding: '.35rem', borderRadius: '14px', background: 'var(--surface-soft)', border: '1px solid var(--glass-border)' }}>
                        {['quiz', 'spectrogram'].map(mode => (
                            <button
                                key={mode}
                                type="button"
                                onClick={() => { setGameMode(mode); setError(''); }}
                                disabled={isUploading}
                                style={{
                                    padding: '.85rem 1rem', borderRadius: '10px', cursor: 'pointer',
                                    border: gameMode === mode ? '1px solid var(--accent)' : '1px solid transparent',
                                    background: gameMode === mode ? 'var(--accent-soft)' : 'transparent',
                                    color: gameMode === mode ? 'var(--accent)' : 'var(--text-secondary)',
                                    fontWeight: 800, fontSize: '1rem'
                                }}
                            >
                                {mode === 'quiz' ? `🧠 ${t('create.quizTab')}` : `🌈 ${t('create.spectrogramTab')}`}
                            </button>
                        ))}
                    </div>

                    {gameMode === 'quiz' ? <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '0.75rem',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                            fontWeight: '500'
                        }}>
                            {t('create.selectPack')}
                        </label>
                        <input
                            type="file"
                            accept=".json"
                            onChange={handleFileChange}
                            disabled={isUploading}
                            style={{
                                width: '100%',
                                padding: '0.75rem',
                                background: 'var(--surface-soft)',
                                border: '1px solid var(--glass-border)',
                                borderRadius: '8px',
                                color: 'var(--text-primary)',
                                fontSize: '1rem',
                                cursor: isUploading ? 'not-allowed' : 'pointer',
                                transition: 'all 0.2s'
                            }}
                        />
                        {file && (
                            <div style={{
                                marginTop: '0.75rem',
                                padding: '0.5rem 1rem',
                                background: 'var(--accent-soft)',
                                border: '1px solid var(--accent)',
                                borderRadius: '8px',
                                color: 'var(--accent)',
                                fontSize: '0.875rem'
                            }}>
                                {t('create.selected', { name: file.name })}
                            </div>
                        )}
                    </div> : (
                        <div>
                            <label style={{ display: 'block', marginBottom: '.75rem', color: 'var(--text-secondary)', fontSize: '.875rem', fontWeight: 500 }}>
                                {t('create.clueMode')}
                            </label>
                            <div className="create-clue-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
                                {['text', 'verbal'].map(mode => (
                                    <button
                                        key={mode}
                                        type="button"
                                        onClick={() => setSpectrogramClueMode(mode)}
                                        disabled={isUploading}
                                        className="glass-panel"
                                        style={{
                                            padding: '1rem', cursor: 'pointer', textAlign: 'left',
                                            border: spectrogramClueMode === mode ? '2px solid var(--accent)' : '1px solid var(--glass-border)',
                                            color: 'var(--text-primary)', background: spectrogramClueMode === mode ? 'var(--accent-soft)' : 'var(--surface-soft)'
                                        }}
                                    >
                                        <div style={{ fontWeight: 800 }}>{mode === 'text' ? `⌨️ ${t('create.textMode')}` : `🎙️ ${t('create.verbalMode')}`}</div>
                                        <div style={{ color: 'var(--text-secondary)', fontSize: '.8rem', marginTop: '.35rem', lineHeight: 1.35 }}>
                                            {mode === 'text' ? t('create.textModeHint') : t('create.verbalModeHint')}
                                        </div>
                                    </button>
                                ))}
                            </div>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '.85rem', lineHeight: 1.5, margin: '1rem 0 0' }}>
                                {t('create.spectrogramHint')}
                            </p>
                        </div>
                    )}

                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '0.75rem',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                            fontWeight: '500'
                        }}>
                            {t('create.passwordLabel')}
                        </label>
                        <input
                            type="text"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder={t('create.passwordPlaceholder')}
                            disabled={isUploading}
                        />
                    </div>

                    <button
                        onClick={handleCreate}
                        disabled={(gameMode === 'quiz' && !file) || isUploading}
                        className="btn-primary"
                        style={{
                            width: '100%',
                            opacity: ((gameMode === 'quiz' && !file) || isUploading) ? 0.5 : 1,
                            cursor: ((gameMode === 'quiz' && !file) || isUploading) ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {isUploading ? t('create.uploading') : t('create.title')}
                    </button>

                    {isUploading && gameMode === 'quiz' && (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.5rem'
                        }}>
                            <div style={{
                                width: '100%',
                                height: '12px',
                                background: 'var(--track)',
                                borderRadius: '999px',
                                overflow: 'hidden',
                                border: '1px solid var(--glass-border)'
                            }}>
                                <div
                                    style={{
                                        width: `${uploadProgress}%`,
                                        height: '100%',
                                        background: 'var(--fill-hover)',
                                        transition: 'width 0.3s ease'
                                    }}
                                />
                            </div>
                            <div style={{
                                textAlign: 'center',
                                color: 'var(--text-secondary)',
                                fontSize: '0.875rem',
                                fontWeight: '600'
                            }}>
                                {uploadProgress}%
                            </div>
                        </div>
                    )}
                </div>

                {error && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid #ef4444',
                        borderRadius: '8px',
                        color: '#ef4444',
                        fontSize: '0.875rem',
                        textAlign: 'center'
                    }}>
                        {translateMessage(error)}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateGamePage;
