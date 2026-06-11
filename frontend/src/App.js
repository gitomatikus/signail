import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import CreateGamePage from './pages/CreateGamePage';
import GameRoomPage from './pages/GameRoomPage';
import QuestionPage from './pages/QuestionPage';
import AuthWrapper from './components/AuthWrapper';
import { GameProvider } from './contexts/GameContext';
import { LanguageProvider } from './i18n/LanguageContext';

// GameProvider needs the logged-in user that AuthWrapper injects, so this
// little bridge receives it as a prop and passes it down.
const GameRoutes = ({ user, onUpdateUser, children }) => (
  <GameProvider user={user} onUpdateUser={onUpdateUser}>
    {children}
  </GameProvider>
);

function App() {
  return (
    <LanguageProvider>
    <Router>
      <Routes>
        <Route path="/" element={
          <AuthWrapper requireAuth={false}>
            <HomePage />
          </AuthWrapper>
        } />
        <Route path="/create" element={
          <AuthWrapper>
            <CreateGamePage />
          </AuthWrapper>
        } />
        <Route path="/game/:gameId" element={
          <AuthWrapper showHeader={false}>
            <GameRoutes>
              <GameRoomPage />
            </GameRoutes>
          </AuthWrapper>
        } />
        <Route path="/game/:gameId/question/:questionId" element={
          <AuthWrapper showHeader={false}>
            <GameRoutes>
              <QuestionPage />
            </GameRoutes>
          </AuthWrapper>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
    </LanguageProvider>
  );
}

export default App;
