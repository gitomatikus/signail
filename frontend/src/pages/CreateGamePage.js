import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import config from '../config';
import { saveHostToken } from '../services/gameAuth';

// Creates a game: registers it (host identity + optional password), then
// streams the selected pack file to the server. The pack file is uploaded
// as-is - the server validates it and stores it on disk.
const CreateGamePage = ({ user }) => {
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
            setError('Please select a valid JSON file');
            setFile(null);
            setUploadProgress(0);
        }
    };

    const uploadPack = (gameId, hostToken) => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${config.apiUrl}/api/games/${gameId}/pack`, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('X-Host-Token', hostToken);

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                setUploadProgress(Math.round((event.loaded * 100) / event.total));
            }
        };
        xhr.onload = () => {
            if (xhr.status === 200) {
                resolve();
            } else {
                let message = 'Failed to upload pack';
                try {
                    message = JSON.parse(xhr.responseText).message || message;
                } catch (e) { /* non-JSON error body */ }
                reject(new Error(message));
            }
        };
        xhr.onerror = () => reject(new Error('Network error occurred'));
        // Send the raw file: the browser streams it, the server pipes it to disk
        xhr.send(file);
    });

    const handleCreate = async () => {
        if (!file) {
            setError('Please select a pack file first');
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
                    password: password || null
                })
            });
            const result = await response.json();
            if (result.status !== 'success') {
                throw new Error(result.message || 'Failed to create game');
            }
            created = result.data;
            saveHostToken(created.gameId, created.hostToken);

            await uploadPack(created.gameId, created.hostToken);
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
        <div className="fade-in" style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem'
        }}>
            <div className="glass-panel" style={{
                padding: '3rem',
                width: '100%',
                maxWidth: '600px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2rem'
            }}>
                <button
                    onClick={() => navigate('/')}
                    className="btn-primary"
                    style={{
                        alignSelf: 'flex-start',
                        background: 'rgba(255, 255, 255, 0.08)',
                        color: 'var(--text-primary)',
                        boxShadow: 'none',
                        border: '1px solid var(--glass-border)'
                    }}
                >
                    Back to Games
                </button>

                <h1 className="text-gradient" style={{
                    fontSize: '3rem',
                    fontWeight: '800',
                    margin: 0,
                    textAlign: 'center'
                }}>
                    Create Game
                </h1>

                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1.5rem'
                }}>
                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '0.75rem',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                            fontWeight: '500'
                        }}>
                            Select Pack File (JSON)
                        </label>
                        <input
                            type="file"
                            accept=".json"
                            onChange={handleFileChange}
                            disabled={isUploading}
                            style={{
                                width: '100%',
                                padding: '0.75rem',
                                background: 'rgba(255, 255, 255, 0.05)',
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
                                background: 'rgba(34, 211, 238, 0.1)',
                                border: '1px solid var(--accent)',
                                borderRadius: '8px',
                                color: 'var(--accent)',
                                fontSize: '0.875rem'
                            }}>
                                Selected: {file.name}
                            </div>
                        )}
                    </div>

                    <div>
                        <label style={{
                            display: 'block',
                            marginBottom: '0.75rem',
                            color: 'var(--text-secondary)',
                            fontSize: '0.875rem',
                            fontWeight: '500'
                        }}>
                            Password (optional - players will need it to join)
                        </label>
                        <input
                            type="text"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="Leave empty for an open game"
                            disabled={isUploading}
                        />
                    </div>

                    <button
                        onClick={handleCreate}
                        disabled={!file || isUploading}
                        className="btn-primary"
                        style={{
                            width: '100%',
                            opacity: (!file || isUploading) ? 0.5 : 1,
                            cursor: (!file || isUploading) ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {isUploading ? 'Uploading...' : 'Create Game'}
                    </button>

                    {isUploading && (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.5rem'
                        }}>
                            <div style={{
                                width: '100%',
                                height: '12px',
                                background: 'rgba(255, 255, 255, 0.1)',
                                borderRadius: '999px',
                                overflow: 'hidden',
                                border: '1px solid var(--glass-border)'
                            }}>
                                <div
                                    style={{
                                        width: `${uploadProgress}%`,
                                        height: '100%',
                                        background: 'linear-gradient(90deg, var(--primary), var(--accent))',
                                        transition: 'width 0.3s ease',
                                        boxShadow: '0 0 10px var(--primary-glow)'
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
                        {error}
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateGamePage;
