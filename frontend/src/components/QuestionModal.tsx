import React from 'react';
import { Question } from '../types/pack';

interface QuestionModalProps {
  open: boolean;
  question: Question | null;
  onClose: () => void;
}

const QuestionModal: React.FC<QuestionModalProps> = ({ open, question, onClose }) => {
  if (!open || !question) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0,0,0,0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: '#1a1a1a',
        padding: '2rem',
        borderRadius: '12px',
        minWidth: '300px',
        maxWidth: '800px',
        width: '90%',
        maxHeight: '90vh',
        overflow: 'auto',
        color: '#fff',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3)'
      }}>
        <h2 style={{ marginBottom: '1.5rem', color: '#ffd600' }}>Question Details</h2>
        <pre style={{
          textAlign: 'left',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: '#2a2a2a',
          padding: '1rem',
          borderRadius: '8px',
          fontSize: '14px',
          lineHeight: '1.5',
          color: '#e0e0e0'
        }}>
          {JSON.stringify(question, null, 2)}
        </pre>
        <button
          onClick={onClose}
          style={{
            marginTop: '1.5rem',
            padding: '0.75rem 1.5rem',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '1rem',
            fontWeight: 'bold'
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default QuestionModal; 