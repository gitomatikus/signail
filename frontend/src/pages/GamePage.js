import React from 'react';
import GameBoard from '../components/GameBoard';
import OnlineUsers from '../components/OnlineUsers';
import { useGame } from '../contexts/GameContext';

const GamePage = () => {
  const { isHost, onlineUsers } = useGame();
  return (
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
        <GameBoard isAdmin={isHost} />
      </div>
      {/* Full width: the player list uses the page sides so a long row fits */}
      <div style={{ width: '100%', margin: 0, padding: 0, lineHeight: 1 }}>
        <OnlineUsers users={onlineUsers} isAdmin={isHost} />
      </div>
    </div>
  );
};

export default GamePage;
