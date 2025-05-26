import React, { useState } from 'react';
import { indexedDBService } from '../services/indexedDB';

const Settings = ({ onClose }) => {
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState('');

  const handleClearCache = async () => {
    try {
      setIsClearing(true);
      setMessage('');
      await indexedDBService.deletePack('current');
      setMessage('Cache cleared successfully!');
    } catch (error) {
      setMessage('Error clearing cache: ' + error.message);
    } finally {
      setIsClearing(false);
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
        <div style={{ marginTop: 20 }}>
          <button
            onClick={handleClearCache}
            disabled={isClearing}
            style={{
              padding: '8px 16px',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: isClearing ? 'not-allowed' : 'pointer'
            }}
          >
            {isClearing ? 'Clearing...' : 'Clear Cache'}
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