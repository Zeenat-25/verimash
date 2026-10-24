'use strict';
// The landing page stays usable even while the demo backend is asleep.
// The existing /app.html smart-start mechanism checks readiness on launch.
(function(){
  const video = document.getElementById('heroVideo');
  const visual = document.querySelector('.hero-visual');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) { video.pause(); }
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const sections = [...document.querySelectorAll('.section')];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
      }
    }, {threshold: 0.08});
    for (const section of sections) { section.classList.add('is-reveal-ready'); observer.observe(section); }
  }
  if (reduceMotion) return;
  let activated = false;
  video.addEventListener('loadeddata', () => {
    if (!activated && video.videoWidth > 0) {
      activated = true;
      visual.classList.add('video-active');
      const playing = video.play();
      if (playing && typeof playing.catch === 'function') playing.catch(() => { visual.classList.remove('video-active'); });
    }
  });
  video.addEventListener('error', () => visual.classList.remove('video-active'));
  for (const source of video.querySelectorAll('source')) source.addEventListener('error', () => {});
  // A single background request can wake Render, but it does not keep the service awake 24/7.
  // Do not poll on this marketing page: conserve Render Free usage.
  fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(12000) }).catch(() => {});
})();
