import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import GamePage from './pages/GamePage';
import QuestionPage from './pages/QuestionPage';
import AuthWrapper from './components/AuthWrapper';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/admin" element={
          <AuthWrapper isAdmin={true}>
            <GamePage />
          </AuthWrapper>
        } />
        <Route path="/admin/question/:questionId" element={
          <AuthWrapper isAdmin={true}>
            <QuestionPage />
          </AuthWrapper>
        } />
        <Route path="/question/:questionId" element={
          <AuthWrapper>
            <QuestionPage isReadOnly={true} />
          </AuthWrapper>
        } />
        <Route path="/" element={
          <AuthWrapper>
            <GamePage />
          </AuthWrapper>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App; 