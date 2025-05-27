import React, { useState, useEffect } from 'react';
import wsManager from '../utils/websocket';
import { useLocation } from 'react-router-dom';

const OnlineUsers = ({ users, elapsedTime, currentUserId, userTimes = {}, isAdmin = false, question }) => {
  const location = useLocation();
  const isQuestionPage = location.pathname.includes('/question/');
  
  // Track which users have had their scores updated
  const [updatedUsers, setUpdatedUsers] = useState(new Set());
  // Track which users have been penalized
  const [penalizedUsers, setPenalizedUsers] = useState(new Set());
  // Track which users have green frames
  const [greenFrameUsers, setGreenFrameUsers] = useState(new Set());

  // Load green framed users from localStorage on component mount
  useEffect(() => {
    const storedGreenFramedUsers = JSON.parse(localStorage.getItem('greenFramedUsers') || '[]');
    // Only set green frames if we're not on the question page
    if (!isQuestionPage) {
      setGreenFrameUsers(new Set(storedGreenFramedUsers));
    }
  }, [isQuestionPage]);

  // Add WebSocket event listener for admin_clicked_red_number and admin_clicked_green_number
  useEffect(() => {
    const unsubscribe = wsManager.subscribe((data) => {
      if (data.type === 'admin_clicked_red_number') {
        console.log('Admin clicked red number for user ID:', data.data.userId);
        // Add user to penalized set to show red frame
        setPenalizedUsers(prev => new Set([...prev, data.data.userId]));
      } else if (data.type === 'admin_clicked_green_number') {
        console.log('Admin clicked green number for user ID:', data.data.userId);
        // Add user to green frame set
        setGreenFrameUsers(prev => {
          const newSet = new Set([data.data.userId]);
          // Store in localStorage
          localStorage.setItem('greenFramedUsers', JSON.stringify([data.data.userId]));
          return newSet;
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Sort users by their times
  const sortedUsers = [...users].sort((a, b) => {
    const timeA = userTimes[a.id] ?? (a.id === currentUserId ? elapsedTime : null);
    const timeB = userTimes[b.id] ?? (b.id === currentUserId ? elapsedTime : null);
    
    if (timeA === null && timeB === null) return 0;
    if (timeA === null) return 1;
    if (timeB === null) return -1;
    
    return timeA - timeB;
  });

  // Get the top 3 fastest times, excluding penalized users
  const topThreeTimes = sortedUsers
    .filter(user => (userTimes[user.id] !== undefined || (user.id === currentUserId && elapsedTime !== null)) && !penalizedUsers.has(user.id))
    .slice(0, 3)
    .map(user => user.id);

  // Get correct and incorrect values from question
  const correctValue = question?.price?.correct ?? 0;
  const incorrectValue = question?.price?.incorrect ?? 0;

  const handleScoreClick = (userId, currentScore, value) => {
    if (!isAdmin) return;
    
    const newScore = currentScore + value;
    wsManager.ws.send(JSON.stringify({
      type: 'update_score',
      data: {
        userId,
        score: newScore
      }
    }));

    if (value > 0) {
      // If it's a correct answer, add user to updated set
      setUpdatedUsers(prev => new Set([...prev, userId]));
      // Send the event to WebSocket server
      wsManager.ws.send(JSON.stringify({
        type: 'admin_clicked_green_number',
        data: {
          userId
        }
      }));
    } else {
      // If it's an incorrect answer, add user to penalized set
      setPenalizedUsers(prev => new Set([...prev, userId]));
      // Log the user ID when admin clicks red number under gold frame
      console.log('Admin clicked red number for user ID:', userId);
      // Send the event to WebSocket server
      wsManager.ws.send(JSON.stringify({
        type: 'admin_clicked_red_number',
        data: {
          userId
        }
      }));
    }
  };

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
      {users.map(user => {
        const userTime = userTimes[user.id] ?? (user.id === currentUserId ? elapsedTime : null);
        const isTopThree = topThreeTimes.includes(user.id);
        const position = topThreeTimes.indexOf(user.id);
        const previousScore = user.score ?? 0;
        const isUpdated = updatedUsers.has(user.id);
        const isPenalized = penalizedUsers.has(user.id);
        const hasGreenFrame = greenFrameUsers.has(user.id);
        
        // Define frame styles based on position
        const getFrameStyle = () => {
          if (hasGreenFrame) {
            return {
              border: '3px solid #44ff44',
              boxShadow: '0 0 15px #44ff44, 0 0 5px #44ff44'
            };
          }
          
          if (isPenalized) {
            return {
              border: '3px solid #ff4444',
              boxShadow: '0 0 15px #ff4444, 0 0 5px #ff4444'
            };
          }

          if (!isTopThree) {
            // Only show black frame if user has answered
            if (userTime === null) {
              return {
                border: 'none',
                boxShadow: 'none'
              };
            }
            return {
              border: '3px solid #000',
              boxShadow: '0 1px 8px rgba(0,0,0,0.10)'
            };
          }
          
          switch (position) {
            case 0: // Gold
              return {
                border: '3px solid #FFD700',
                boxShadow: '0 0 15px #FFD700, 0 0 5px #FFD700'
              };
            case 1: // Silver
              return {
                border: '3px solid #E8E8E8',
                boxShadow: '0 0 20px #E8E8E8, 0 0 10px #E8E8E8, 0 0 5px #E8E8E8'
              };
            case 2: // Bronze
              return {
                border: '3px solid #CD7F32',
                boxShadow: '0 0 15px #CD7F32, 0 0 5px #CD7F32'
              };
            default:
              return {
                border: '3px solid #fff',
                boxShadow: '0 1px 8px rgba(0,0,0,0.10)'
              };
          }
        };

        return (
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
            {userTime !== null && (
              <div style={{
                position: 'absolute',
                top: -30,
                left: '50%',
                transform: 'translateX(-50%)',
                background: 'rgba(0, 0, 0, 0.7)',
                color: '#fff',
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '1.2rem',
                fontWeight: 'bold',
                zIndex: 1
              }}>
                {typeof userTime === 'number' ? userTime.toFixed(3) : userTime}s
              </div>
            )}
            {user.imageUrl.toLowerCase().endsWith('.mp4') ? (
              <video
                src={user.imageUrl}
                style={{
                  width: '110px',
                  height: '110px',
                  borderRadius: '18px',
                  objectFit: 'cover',
                  marginBottom: '0.7rem',
                  background: '#222',
                  ...getFrameStyle()
                }}
                autoPlay
                loop
                muted
                playsInline
              />
            ) : (
              <img
                src={user.imageUrl}
                alt={user.name}
                style={{
                  width: '110px',
                  height: '110px',
                  borderRadius: '18px',
                  objectFit: 'cover',
                  marginBottom: '0.7rem',
                  background: '#222',
                  ...getFrameStyle()
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  wsManager.ws.send(JSON.stringify({
                    type: 'admin_clicked_green_number',
                    data: {
                      userId: user.id
                    }
                  }));
                }}
              />
            )}
            <span style={{ fontWeight: 'bold', fontSize: '1.5rem', color: user.isCurrent ? '#aaa' : '#aaa', marginBottom: '0.4rem', textAlign: 'center', wordBreak: 'break-word' }}>{user.name}</span>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontWeight: 'bold', fontSize: '1.5rem', color: '#aaa', textAlign: 'center' }}>{previousScore}</span>
              {isAdmin && position === 0 && !isUpdated && !isPenalized && (
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <span 
                    onClick={() => handleScoreClick(user.id, previousScore, incorrectValue)}
                    style={{ 
                      fontWeight: 'bold', 
                      fontSize: '1.2rem', 
                      color: '#ff4444',
                      cursor: 'pointer',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      transition: 'background-color 0.2s',
                      ':hover': {
                        backgroundColor: 'rgba(255, 68, 68, 0.1)'
                      }
                    }}
                  >
                    {incorrectValue}
                  </span>
                  <span style={{ fontWeight: 'bold', fontSize: '1.2rem', color: '#aaa' }}>/</span>
                  <span 
                    onClick={() => handleScoreClick(user.id, previousScore, correctValue)}
                    style={{ 
                      fontWeight: 'bold', 
                      fontSize: '1.2rem', 
                      color: '#44ff44',
                      cursor: 'pointer',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      transition: 'background-color 0.2s',
                      ':hover': {
                        backgroundColor: 'rgba(68, 255, 68, 0.1)'
                      }
                    }}
                  >
                    {correctValue}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default OnlineUsers; 