import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { initVolumeManager } from './utils/volumeManager';
import { initTheme } from './utils/theme';

// Initialize global volume manager for video and audio elements
initVolumeManager();
// Apply the player's saved theme before first paint
initTheme();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
 