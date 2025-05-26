import React from 'react';

const QuestionModal = ({ open, question, onClose }) => {
  if (!open || !question) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{ background: 'white', padding: 24, borderRadius: 8, minWidth: 300, maxWidth: 600 }}>
        <h3>Question Details</h3>
        <pre style={{ textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(question, null, 2)}
        </pre>
        <button onClick={onClose} style={{ marginTop: 16 }}>Close</button>
      </div>
    </div>
  );
};

export default QuestionModal; 