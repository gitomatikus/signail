import React, { useState, useEffect } from 'react';
import LoginPage from './LoginPage';
import wsManager from '../utils/websocket';
import config from '../config';

const AuthWrapper = ({ children, isAdmin = false }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState([]);

  const fetchOnlineUsers = async () => {
    try {
      const response = await fetch(`${config.apiUrl}/api/users/online`);
      const result = await response.json();
      if (result.status === 'success') {
        setOnlineUsers(result.data);
      }
    } catch (error) {
      console.error('Error fetching online users:', error);
    }
  };

  const handleWebSocketConnection = () => {
    // Initialize WebSocket connection
    wsManager.connect();

    // Subscribe to WebSocket events
    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'online_users') {
        setOnlineUsers(data.data);
      }
    });

    return unsubscribe;
  };

  useEffect(() => {
    let unsubscribe;

    if (isAdmin) {
      // For admin mode, set up WebSocket and fetch users immediately
      unsubscribe = handleWebSocketConnection();
      fetchOnlineUsers();
      setLoading(false);
    } else {
      // Check for existing user data in localStorage
      const storedUser = localStorage.getItem('user');
      if (storedUser) {
        try {
          const userData = JSON.parse(storedUser);
          setUser(userData);
          
          // Set up WebSocket connection
          unsubscribe = handleWebSocketConnection();
          
          // Wait for WebSocket to connect before sending user data
          const checkConnection = setInterval(() => {
            if (wsManager.ws && wsManager.ws.readyState === WebSocket.OPEN) {
              clearInterval(checkConnection);
              // Notify server about existing user
              wsManager.sendUserLogin(userData);
              // Fetch current online users
              fetchOnlineUsers();
            }
          }, 100);

          // Cleanup interval after 5 seconds if connection fails
          setTimeout(() => clearInterval(checkConnection), 5000);
        } catch (error) {
          console.error('Error parsing stored user data:', error);
          localStorage.removeItem('user');
        }
      }
      setLoading(false);
    }

    // Cleanup
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
      wsManager.disconnect();
    };
  }, [isAdmin]);

  const handleLogin = (userData) => {
    setUser(userData);
    // Notify server about new user
    wsManager.sendUserLogin(userData);
    // Fetch current online users
    fetchOnlineUsers();
  };

  const handleLogout = () => {
    if (user && wsManager.ws && wsManager.ws.readyState === WebSocket.OPEN) {
      // Notify server about user logout
      wsManager.ws.send(JSON.stringify({
        type: 'user_logout',
        data: user
      }));
    }
    localStorage.removeItem('user');
    setUser(null);
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh'
      }}>
        Loading...
      </div>
    );
  }

  // In admin mode, skip login and render the game directly
  if (isAdmin) {
    return (
      <div>
        <div style={{
          position: 'fixed',
          top: 0,
          right: 0,
          padding: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          zIndex: 1000
        }}>
          <div style={{ 
            padding: '0.5rem 1rem',
            background: '#28a745',
            color: 'white',
            borderRadius: '4px',
            fontWeight: 'bold'
          }}>
            Admin Mode
          </div>
        </div>
        {React.cloneElement(children, { onlineUsers, isAdmin })}
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // If we have a user, render the children (game) with the user context
  return (
    <div>
      <div style={{
        position: 'fixed',
        top: 0,
        right: 0,
        padding: '1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        zIndex: 1000
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <img
            src={user.imageUrl}
            alt={user.name}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              objectFit: 'cover'
            }}
          />
          <span style={{ color: '#aaa' }}>{user.name}</span>
        </div>
        <button
          onClick={handleLogout}
          style={{
            padding: '0.5rem 1rem',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Logout
        </button>
      </div>
      {React.cloneElement(children, { onlineUsers, isAdmin })}
    </div>
  );
};

export default AuthWrapper; 