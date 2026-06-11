import React from 'react';

// Brand mark: "Jeo" in plain text, "party" in the primary blue.
const Logo = ({ fontSize = '3.5rem', style }) => (
  <h1 className="brand-logo" style={{ fontSize, ...style }}>
    Jeo<span>party</span>
  </h1>
);

export default Logo;
