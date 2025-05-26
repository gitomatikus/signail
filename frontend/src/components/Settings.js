import React, { useState } from 'react';
import { indexedDBService } from '../services/indexedDB';
import wsManager from '../utils/websocket';

const Settings = ({ onClose, isAdmin = false }) => {
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [isClearingPack, setIsClearingPack] = useState(false);
  const [message, setMessage] = useState('');

  const handleClearCache = async () => {
    try {
      setIsClearingCache(true);
      setMessage('');
      wsManager.sendClearCache();
      setMessage('Cache cleared successfully!');
    } catch (error) {
      setMessage('Error clearing cache: ' + error.message);
    } finally {
      setIsClearingCache(false);
    }
  };

  const handleClearPack = async () => {
    try {
      setIsClearingPack(true);
      setMessage('');
      await indexedDBService.deletePack('current');
      setMessage('Pack cleared successfully!');
    } catch (error) {
      setMessage('Error clearing pack: ' + error.message);
    } finally {
      setIsClearingPack(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: 'white',
        padding: 24,
        borderRadius: 8,
        minWidth: 300,
        maxWidth: 600
      }}>
        <h2>Settings</h2>
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {isAdmin && (
            <button
              onClick={handleClearCache}
              disabled={isClearingCache}
              style={{
                padding: '8px 16px',
                background: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: isClearingCache ? 'not-allowed' : 'pointer'
              }}
            >
              {isClearingCache ? 'Clearing...' : 'Clear Cache'}
            </button>
          )}
          <button
            onClick={handleClearPack}
            disabled={isClearingPack}
            style={{
              padding: '8px 16px',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: isClearingPack ? 'not-allowed' : 'pointer'
            }}
          >
            {isClearingPack ? 'Clearing...' : 'Clear Pack'}
          </button>
          {message && (
            <p style={{
              marginTop: 10,
              color: message.includes('Error') ? '#dc3545' : '#28a745'
            }}>
              {message}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 20,
            padding: '8px 16px',
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer'
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default Settings; 