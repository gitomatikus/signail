import React from 'react';
import GamePage from './pages/GamePage';
import AuthWrapper from './components/AuthWrapper';

function App() {
  return (
    <AuthWrapper>
      <GamePage />
    </AuthWrapper>
  );
}

export default App; 