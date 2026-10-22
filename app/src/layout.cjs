'use strict';

function workspaceBounds(width, height, platform, open) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError('Dimensões inválidas');
  }
  const w = Math.floor(width), h = Math.floor(height);
  const drawerWidth = Math.min(600, Math.max(420, Math.floor(w * 0.42)));
  const netflixActive = platform === 'netflix';
  return {
    duotela: netflixActive ? { x: open ? 0 : -drawerWidth, y: 0, width: drawerWidth, height: h } : { x: 0, y: 0, width: w, height: h },
    netflix: { x: 0, y: 0, width: w, height: h },
    toggle: netflixActive ? { x: open ? drawerWidth + 14 : 14, y: 14, width: 160, height: 50 } : null
  };
}

module.exports = { workspaceBounds };
