const photos = [...document.querySelectorAll('.sky-photo')];
const choices = [...document.querySelectorAll('[data-sky]')];
const pauseButton = document.querySelector('#skyPause');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
let current = 0;
let paused = motion.matches;
let timer;
function copy(key, fallback) { return window.portalCopy?.[key] || fallback; }

function selectPhoto(index) {
  // Keep the current image visible if the next image has not loaded.
  if (!photos[index].complete || !photos[index].naturalWidth) return;
  current = index;
  photos.forEach((photo, i) => photo.classList.toggle('is-active', i === current));
  choices.forEach((button, i) => button.setAttribute('aria-pressed', String(i === current)));
}

function schedule() {
  clearInterval(timer);
  if (!paused && !document.hidden) timer = setInterval(() => selectPhoto((current + 1) % photos.length), 10000);
  pauseButton.textContent = paused ? copy('play', '播放轮换') : copy('pause', '暂停轮换');
  pauseButton.setAttribute('aria-label', paused ? '播放背景轮换' : '暂停背景轮换');
  pauseButton.setAttribute('aria-pressed', String(paused));
}

choices.forEach((button) => button.addEventListener('click', () => {
  selectPhoto(Number(button.dataset.sky));
  schedule();
}));
pauseButton.addEventListener('click', () => { paused = !paused; schedule(); });
document.addEventListener('visibilitychange', schedule);
document.addEventListener('portal-copy', schedule);
motion.addEventListener('change', () => { paused = motion.matches; schedule(); });
document.querySelector('.sky-controls').hidden = false;
schedule();
