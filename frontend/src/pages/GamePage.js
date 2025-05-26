import React from 'react';
import GameBoard from '../components/GameBoard';
import OnlineUsers from '../components/OnlineUsers';

const GamePage = ({ onlineUsers, isAdmin = false }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      minHeight: '100vh',
      padding: 0,
      gap: 0,
    }}
  >
    <div style={{ width: '100%', maxWidth: 1200, margin: '0 auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <GameBoard isAdmin={isAdmin} />
    </div>
    <div style={{ width: '100%', maxWidth: 1200, margin: 0, padding: 0, lineHeight: 1 }}>
      <OnlineUsers users={onlineUsers} />
    </div>
  </div>
);

export default GamePage; 