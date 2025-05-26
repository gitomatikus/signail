import React, { useState } from 'react';

const LoginPage = ({ onLogin }) => {
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');

  const validateImageUrl = (url) => {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.webp'];
    return validExtensions.some(ext => url.toLowerCase().endsWith(ext));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Please enter your name');
      return;
    }

    if (!imageUrl.trim()) {
      setError('Please enter an image URL');
      return;
    }

    if (!validateImageUrl(imageUrl)) {
      setError('Please enter a valid image URL (jpg, jpeg, png, gif, mp4, or webp)');
      return;
    }

    const userData = {
      id: `${name.trim()}-${Date.now()}`,
      name: name.trim(),
      imageUrl: imageUrl.trim(),
      lastLogin: new Date().toISOString(),
      score: 0
    };

    localStorage.setItem('user', JSON.stringify(userData));
    onLogin(userData);
  };

  const showPreview = imageUrl && validateImageUrl(imageUrl);

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      background: '#f5f5f5'
    }}>
      <div style={{
        background: 'white',
        padding: '2rem',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
        width: '100%',
        maxWidth: '400px'
      }}>
        <h1 style={{ marginBottom: '1.5rem', textAlign: 'center' }}>Login</h1>
        {error && (
          <div style={{
            color: '#dc3545',
            marginBottom: '1rem',
            padding: '0.5rem',
            background: '#f8d7da',
            borderRadius: '4px'
          }}>
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
              Name:
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
              Image URL:
            </label>
            <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
              <a href="https://giphy.com" target="_blank" rel="noopener noreferrer" style={{ color: '#007bff', textDecoration: 'none' }}>
                upload
              </a>
            </div>
            {showPreview && (
              <div style={{
                width: 80,
                height: 80,
                margin: '0 auto 0.5rem auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 12,
                border: '2px solid #eee',
                background: '#fafafa',
                overflow: 'hidden',
              }}>
                {imageUrl.toLowerCase().endsWith('.mp4') ? (
                  <video
                    src={imageUrl}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 12,
                    }}
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                ) : (
                  <img
                    src={imageUrl}
                    alt="preview"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 12,
                    }}
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                )}
              </div>
            )}
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem',
                border: '1px solid #ddd',
                borderRadius: '4px'
              }}
            />
          </div>
          <button
            type="submit"
            style={{
              width: '100%',
              padding: '0.75rem',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage; 