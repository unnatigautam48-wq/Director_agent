// Slate — a small agent loop that watches a video feed, scores the shot on
// three signals (framing, motion energy, light), decides what's wrong,
// speaks a note about it, and calls cut once the shot holds up for a bit.
//
// No backend, no model download — the perception step is done by hand with
// plain canvas pixel math (skin-tone blob for framing, frame differencing
// for motion, a brightness histogram for light). That keeps it fast and
// keeps it working even with no wifi at the venue.

const video = document.getElementById('cam');
const overlay = document.getElementById('overlay');
const work = document.getElementById('work');
const thumbCanvas = document.getElementById('thumb');
const tally = document.getElementById('tally');
const logEl = document.getElementById('log');
const filmstrip = document.getElementById('filmstrip');
const briefInput = document.getElementById('brief');

const bars = {
  frame: document.getElementById('bar-frame'),
  motion: document.getElementById('bar-motion'),
  light: document.getElementById('bar-light'),
};

const btnRoll = document.getElementById('btn-roll');
const btnCut = document.getElementById('btn-cut');
const fileInput = document.getElementById('file-input');

const WORK_W = 160, WORK_H = 90;
const workCtx = work.getContext('2d', { willReadFrequently: true });
const overlayCtx = overlay.getContext('2d');
work.width = WORK_W;
work.height = WORK_H;

let rolling = false;
let prevGray = null;
let lastIssue = null;
let lastSpoken = null;
let issueStreak = 0;
let goodStreak = 0;
let takeCount = 0;
let history = []; // notes for the current take
let loopHandle = null;

const CUT_THRESHOLD_TICKS = 4; // ~4 ticks of a clean shot before we print it
const TICK_MS = 650;

// ---------- scene brief → target energy ----------
// Very small keyword read of the brief. Not meant to be clever, just enough
// to make the agent's targets depend on what the shot is supposed to be.
function readBrief(text) {
  const t = text.toLowerCase();
  let targetMotion = 32; // 0-100 scale, "typical" conversational stillness
  if (/(nervous|tense|waiting|grief|quiet|still)/.test(t)) targetMotion = 16;
  if (/(chase|action|fight|panic|run|excited)/.test(t)) targetMotion = 62;
  let tightFrame = /(close.?up|intimate|nervous)/.test(t);
  return { targetMotion, tightFrame };
}

// ---------- perception ----------
function grayscaleAndSkin(imageData) {
  const { data } = imageData;
  const n = WORK_W * WORK_H;
  const gray = new Float32Array(n);
  let skinCount = 0, sumX = 0, sumY = 0;
  let minX = WORK_W, maxX = 0, minY = WORK_H, maxY = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;

    // YCbCr skin-tone gate
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (cb > 77 && cb < 127 && cr > 133 && cr < 173 && y > 40) {
      const x = i % WORK_W, yy = Math.floor(i / WORK_W);
      sumX += x; sumY += yy; skinCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (yy < minY) minY = yy;
      if (yy > maxY) maxY = yy;
    }
  }

  const skinFrac = skinCount / n;
  const box = skinCount > 8
    ? { minX, maxX, minY, maxY, cx: sumX / skinCount, cy: sumY / skinCount }
    : null;

  return { gray, skinFrac, box };
}

function scoreFraming(box, skinFrac, tightFrame) {
  if (!box) return { score: 0, note: 'no subject in frame' };

  const targetFrac = tightFrame ? 0.16 : 0.09;
  const sizeDelta = Math.abs(skinFrac - targetFrac) / targetFrac;
  const sizeScore = Math.max(0, 100 - sizeDelta * 90);

  // rule-of-thirds read on the horizontal axis
  const cxNorm = box.cx / WORK_W;
  const distToThird = Math.min(Math.abs(cxNorm - 0.33), Math.abs(cxNorm - 0.66));
  const posScore = Math.max(0, 100 - distToThird * 260);

  const score = Math.round(sizeScore * 0.5 + posScore * 0.5);

  let note;
  if (skinFrac < 0.02) note = 'subject is too far back, barely reads';
  else if (sizeDelta > 0.5 && skinFrac > targetFrac) note = 'too close, coming in tight';
  else if (cxNorm < 0.3 || cxNorm > 0.7) note = 'off to one side, want it near a third-line';
  else note = 'framing reads fine';

  return { score, note, cxNorm };
}

function scoreMotion(gray, prev, targetMotion) {
  if (!prev) return { score: 60, note: 'settling', raw: targetMotion };
  let diff = 0;
  for (let i = 0; i < gray.length; i++) diff += Math.abs(gray[i] - prev[i]);
  const raw = Math.min(100, (diff / gray.length) * 2.2);
  const delta = Math.abs(raw - targetMotion);
  const score = Math.max(0, 100 - delta * 1.6);

  let note;
  if (raw > targetMotion + 18) note = 'too much movement for this scene';
  else if (raw < targetMotion - 18) note = 'too static, give it some life';
  else note = 'energy matches the brief';

  return { score, note, raw };
}

function scoreLight(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) ** 2;
  const contrast = Math.sqrt(variance / gray.length);

  const meanScore = Math.max(0, 100 - Math.abs(mean - 128) * 0.9);
  const contrastScore = Math.min(100, contrast * 2.4);
  const score = Math.round(meanScore * 0.7 + contrastScore * 0.3);

  let note;
  if (mean < 70) note = 'too dark, lift the key light';
  else if (mean > 190) note = 'blown out, pull the exposure back';
  else if (contrast < 20) note = 'flat, needs more contrast';
  else note = 'light is holding';

  return { score, note, mean };
}

// ---------- director agent: pick the one thing worth saying ----------
const phrasing = {
  frame_left: ['move right, into frame', 'you drifted left, come back right'],
  frame_right: ['move left, into frame', 'you drifted right, come back left'],
  frame_size_close: ['step back a touch', 'give the lens more room'],
  frame_size_far: ['come in closer', 'lean toward camera'],
  frame_missing: ['get into frame', 'I need you in the shot'],
  motion_high: ['settle down, slower', 'pull the energy back'],
  motion_low: ['give me more, don\u2019t hold still', 'more energy, this scene needs it'],
  light_dark: ['can we get more light on the face', 'too dark, need more light'],
  light_bright: ['pull that light back, it\u2019s blown out', 'too hot, ease the light'],
  light_flat: ['add some shadow, it reads flat'],
};

function decide(frame, motion, light) {
  const signals = [
    { key: 'frame', score: frame.score },
    { key: 'motion', score: motion.score },
    { key: 'light', score: light.score },
  ];
  signals.sort((a, b) => a.score - b.score);
  const worst = signals[0];

  if (worst.score >= 62) return null; // shot is fine, nothing to say

  let tag;
  if (worst.key === 'frame') {
    if (frame.note.includes('far back')) tag = 'frame_missing';
    else if (frame.note.includes('too close')) tag = 'frame_size_close';
    else if (frame.note.includes('side') && frame.cxNorm < 0.5) tag = 'frame_left';
    else if (frame.note.includes('side')) tag = 'frame_right';
    else tag = 'frame_size_far';
  } else if (worst.key === 'motion') {
    tag = motion.note.includes('much') ? 'motion_high' : 'motion_low';
  } else {
    if (light.note.includes('dark')) tag = 'light_dark';
    else if (light.note.includes('blown')) tag = 'light_bright';
    else tag = 'light_flat';
  }

  return { key: worst.key, tag };
}

// ---------- log + voice ----------
function log(text, cls) {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.textContent = text;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
  history.push(text);
}

function speak(line) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(line);
  u.rate = 1.02;
  u.pitch = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- main loop ----------
function tick() {
  if (!rolling) return;

  workCtx.drawImage(video, 0, 0, WORK_W, WORK_H);
  const imageData = workCtx.getImageData(0, 0, WORK_W, WORK_H);
  const { gray, skinFrac, box } = grayscaleAndSkin(imageData);

  const { targetMotion, tightFrame } = readBrief(briefInput.value);
  const frame = scoreFraming(box, skinFrac, tightFrame);
  const motion = scoreMotion(gray, prevGray, targetMotion);
  const light = scoreLight(gray);
  prevGray = gray;

  bars.frame.style.width = frame.score + '%';
  bars.motion.style.width = motion.score + '%';
  bars.light.style.width = light.score + '%';
  for (const [k, el] of Object.entries(bars)) {
    const s = { frame, motion, light }[k].score;
    el.style.background = s >= 62 ? 'var(--green)' : s >= 35 ? 'var(--amber)' : 'var(--red)';
  }

  drawOverlay(box);

  const decision = decide(frame, motion, light);

  if (decision) {
    goodStreak = 0;
    if (decision.tag === lastIssue) {
      issueStreak++;
    } else {
      issueStreak = 1;
      lastIssue = decision.tag;
    }
    log(`reading the shot — ${decision.key} is the weak point`, 'issue');

    // vary phrasing so it doesn't repeat itself like a script
    const options = phrasing[decision.tag];
    const line = options[issueStreak % options.length];
    if (line !== lastSpoken) {
      log(`"${line}"`, 'direction');
      speak(line);
      lastSpoken = line;
    }
  } else {
    lastIssue = null;
    issueStreak = 0;
    goodStreak++;
    if (goodStreak === 1) log('shot is holding, checking it holds up', null);
    if (goodStreak >= CUT_THRESHOLD_TICKS) {
      printTake({ frame, motion, light });
      goodStreak = 0;
    }
  }
}

function drawOverlay(box) {
  overlay.width = overlay.clientWidth;
  overlay.height = overlay.clientHeight;
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.strokeStyle = 'rgba(237,234,227,0.35)';
  overlayCtx.lineWidth = 1;
  // rule-of-thirds guide
  for (const f of [1 / 3, 2 / 3]) {
    overlayCtx.beginPath();
    overlayCtx.moveTo(overlay.width * f, 0);
    overlayCtx.lineTo(overlay.width * f, overlay.height);
    overlayCtx.stroke();
  }
  if (box) {
    const sx = overlay.width / WORK_W, sy = overlay.height / WORK_H;
    overlayCtx.strokeStyle = 'rgba(76,140,107,0.85)';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(box.minX * sx, box.minY * sy, (box.maxX - box.minX) * sx, (box.maxY - box.minY) * sy);
  }
}

// ---------- cut / continuity agent ----------
function printTake(scores) {
  takeCount++;
  log(`— CUT. printing take ${takeCount} —`, 'cut');
  speak('cut, print that');

  thumbCanvas.width = 320;
  thumbCanvas.height = 180;
  const tctx = thumbCanvas.getContext('2d');
  tctx.drawImage(video, 0, 0, 320, 180);
  const dataUrl = thumbCanvas.toDataURL('image/jpeg', 0.85);

  if (filmstrip.querySelector('.empty-note')) filmstrip.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'take';
  const notesGiven = history.filter(h => h.startsWith('"')).length;
  card.innerHTML = `
    <img src="${dataUrl}">
    <div class="take-meta">
      <b>Take ${takeCount}</b><br>
      framing ${scores.frame.score} · motion ${scores.motion.score} · light ${scores.light.score}<br>
      ${notesGiven} note${notesGiven === 1 ? '' : 's'} given before it held
    </div>`;
  filmstrip.appendChild(card);
  history = [];
}

// ---------- start / stop / source switching ----------
async function startFromWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
  video.srcObject = stream;
  video.play();
  begin();
}

function startFromFile(file) {
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.loop = true;
  video.muted = true;
  video.play();
  begin();
}

function begin() {
  rolling = true;
  prevGray = null;
  goodStreak = 0;
  lastIssue = null;
  tally.classList.add('live');
  btnRoll.textContent = 'Rolling…';
  btnCut.disabled = false;
  log('rolling. reading the frame.', null);
  loopHandle = setInterval(tick, TICK_MS);
}

btnRoll.addEventListener('click', async () => {
  if (rolling) return;
  try {
    await startFromWebcam();
  } catch (err) {
    log('camera not available — use "use a clip" to load footage instead', 'issue');
  }
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) startFromFile(file);
});

btnCut.addEventListener('click', () => {
  clearInterval(loopHandle);
  rolling = false;
  tally.classList.remove('live');
  btnRoll.textContent = 'Roll camera';
  btnCut.disabled = true;
  speechSynthesis.cancel();
  log('cutting camera.', null);
});
