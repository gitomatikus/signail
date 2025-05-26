import React from 'react';

const OnlineUsers = ({ users }) => {
  return (
    <div style={{
      width: '100%',
      display: 'flex',
      justifyContent: 'center',
      marginTop: 0,
      marginBottom: 0,
      gap: '2.5rem',
      flexWrap: 'wrap',
      minHeight: '250px',
      alignItems: 'center',
    }}>
      {users.map(user => (
        <div
          key={user.id || user.name}
          style={{
            background: 'transparent',
            boxShadow: 'none',
            width: '150px',
            height: '200px',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            border: 'none',
            position: 'relative',
            justifyContent: 'flex-start',
          }}
        >
          <img
            src={user.imageUrl}
            alt={user.name}
            style={{
              width: '110px',
              height: '110px',
              borderRadius: '18px',
              objectFit: 'cover',
              marginBottom: '0.7rem',
              border: '3px solid #fff',
              background: '#222',
              boxShadow: '0 1px 8px rgba(0,0,0,0.10)'
            }}
          />
          <span style={{ fontWeight: 'bold', fontSize: '1.5rem', color: user.isCurrent ? '#aaa' : '#aaa', marginBottom: '0.4rem', textAlign: 'center', wordBreak: 'break-word' }}>{user.name}</span>
          <span style={{ fontWeight: 'bold', fontSize: '1.5rem', color: '#aaa', textAlign: 'center' }}>{user.score ?? 0}</span>
        </div>
      ))}
    </div>
  );
};

export default OnlineUsers; 