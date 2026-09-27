/**
 * Draws believable, low-fi "ESP32-CAM" frames for the demo so the vision
 * pipeline (Blob → ImageBitmap → canvas) is exercised end to end.
 * Scenes: 0 footpath + scooter, 1 road crossing, 2 steps + pharmacy sign, 3 banknote.
 */
const W = 640;
const H = 480;

type G = CanvasRenderingContext2D;

function rr(g: G, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function poly(g: G, pts: number[][], fill: string) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

function street(g: G, vx: number, vy: number) {
  const sky = g.createLinearGradient(0, 0, 0, vy + 20);
  sky.addColorStop(0, '#c9dde4');
  sky.addColorStop(1, '#eef1ea');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // buildings left / right in perspective
  poly(g, [[0, 0], [vx - 70, vy - 110], [vx - 70, vy + 8], [0, H * 0.78]], '#b9a58e');
  poly(g, [[W, 0], [vx + 70, vy - 120], [vx + 70, vy + 8], [W, H * 0.78]], '#a7b7b4');
  g.fillStyle = 'rgba(40,50,60,.35)';
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    const x = (vx - 70) * t;
    g.fillRect(x + 8, 40 + t * 90, 26 - t * 14, 40 - t * 20);
    const xr = W - (W - vx - 70) * t;
    g.fillRect(xr - 34 + t * 14, 34 + t * 90, 26 - t * 14, 40 - t * 20);
  }

  // footpath
  poly(g, [[0, H], [W, H], [vx + 60, vy + 10], [vx - 60, vy + 10]], '#b4ada2');
  g.strokeStyle = 'rgba(80,70,60,.25)';
  g.lineWidth = 1.5;
  for (let i = 1; i < 9; i++) {
    const y = vy + 10 + (H - vy - 10) * Math.pow(i / 9, 1.8);
    const k = (y - vy) / (H - vy);
    g.beginPath();
    g.moveTo(vx - 60 - (vx - 60) * k * 1.05, y);
    g.lineTo(vx + 60 + (W - vx - 60) * k * 1.05, y);
    g.stroke();
  }
  for (let i = -3; i <= 3; i++) {
    g.beginPath();
    g.moveTo(vx + i * 16, vy + 10);
    g.lineTo(vx + i * 150, H);
    g.stroke();
  }
}

function person(g: G, x: number, y: number, s: number, c: string) {
  g.fillStyle = c;
  g.beginPath();
  g.arc(x, y - 30 * s, 7 * s, 0, Math.PI * 2);
  g.fill();
  rr(g, x - 9 * s, y - 22 * s, 18 * s, 34 * s, 7 * s);
  g.fill();
}

function scene0(g: G) {
  street(g, 330, 190);
  person(g, 350, 225, 0.9, '#44505a');
  // shop entrance on the right with striped awning
  poly(g, [[520, 150], [640, 120], [640, 330], [520, 300]], '#3a3f45');
  for (let i = 0; i < 6; i++) {
    poly(g, [[500 + i * 24, 132 - i * 6], [524 + i * 24, 126 - i * 6], [528 + i * 24, 152 - i * 6], [504 + i * 24, 158 - i * 6]], i % 2 ? '#f3efe6' : '#c64a3a');
  }
  // scooter ahead-left
  g.fillStyle = '#1f2327';
  g.beginPath(); g.ellipse(200, 372, 30, 32, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(318, 372, 30, 32, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#9aa1a6';
  g.beginPath(); g.ellipse(200, 372, 12, 13, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(318, 372, 12, 13, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2f7fa6';
  rr(g, 190, 300, 150, 56, 26); g.fill();
  poly(g, [[190, 330], [210, 250], [238, 250], [232, 330]], '#2f7fa6');
  g.fillStyle = '#18191b';
  rr(g, 250, 288, 86, 18, 9); g.fill();
  g.strokeStyle = '#18191b'; g.lineWidth = 6;
  g.beginPath(); g.moveTo(206, 252); g.lineTo(186, 238); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.18)';
  g.beginPath(); g.ellipse(260, 405, 120, 14, 0, 0, Math.PI * 2); g.fill();
}

function scene1(g: G) {
  street(g, 300, 170);
  // road band
  poly(g, [[0, 330], [W, 330], [W, 250], [0, 250]], '#50555b');
  for (let i = 0; i < 9; i++) {
    const x = 40 + i * 64;
    poly(g, [[x, 326], [x + 36, 326], [x + 30, 254], [x + 6, 254]], '#eceae4');
  }
  // car on the right
  g.fillStyle = '#b8403a';
  rr(g, 430, 200, 200, 70, 22); g.fill();
  rr(g, 470, 168, 120, 46, 18); g.fill();
  g.fillStyle = '#cfe2ea';
  rr(g, 482, 176, 44, 30, 8); g.fill();
  rr(g, 534, 176, 44, 30, 8); g.fill();
  g.fillStyle = '#1b1d20';
  g.beginPath(); g.arc(470, 272, 20, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(590, 272, 20, 0, Math.PI * 2); g.fill();
  // signal pole
  g.fillStyle = '#2b2f33';
  g.fillRect(96, 90, 10, 180);
  rr(g, 78, 60, 46, 96, 10); g.fill();
  const glow = g.createRadialGradient(101, 84, 2, 101, 84, 26);
  glow.addColorStop(0, 'rgba(255,70,50,1)');
  glow.addColorStop(1, 'rgba(255,70,50,0)');
  g.fillStyle = glow;
  g.beginPath(); g.arc(101, 84, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ff4a36';
  g.beginPath(); g.arc(101, 84, 10, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#3a3a3a';
  g.beginPath(); g.arc(101, 112, 10, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(101, 138, 10, 0, Math.PI * 2); g.fill();
}

function scene2(g: G) {
  street(g, 320, 150);
  // storefront + door
  g.fillStyle = '#d9d4ca';
  g.fillRect(150, 40, 340, 250);
  g.fillStyle = '#2f3a3f';
  rr(g, 262, 120, 116, 170, 6); g.fill();
  g.fillStyle = 'rgba(190,220,230,.5)';
  rr(g, 274, 132, 92, 90, 4); g.fill();
  // sign
  g.fillStyle = '#1f7a5a';
  rr(g, 176, 56, 288, 50, 8); g.fill();
  g.fillStyle = '#ffffff';
  g.fillRect(196, 70, 22, 8); g.fillRect(203, 63, 8, 22);
  g.font = '700 26px system-ui, sans-serif';
  g.fillText('CITY PHARMACY', 230, 91);
  // steps
  const steps = [[120, 290, 400], [96, 330, 448], [66, 378, 508]];
  steps.forEach(([x, y, w], i) => {
    g.fillStyle = ['#c9c3b8', '#bdb6aa', '#b1a99c'][i];
    g.fillRect(x, y, w, 44);
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.fillRect(x, y + 38, w, 6);
  });
  // railing
  g.strokeStyle = '#6d7479';
  g.lineWidth = 7;
  g.beginPath(); g.moveTo(560, 430); g.lineTo(470, 250); g.stroke();
  g.lineWidth = 5;
  [[545, 400], [515, 340], [488, 286]].forEach(([x, y]) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 60); g.stroke(); });
}

function scene3(g: G) {
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#6c5b4d');
  bg.addColorStop(1, '#3d342d');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // hand
  g.fillStyle = '#b98a6a';
  rr(g, 70, 250, 260, 240, 90); g.fill();
  // note
  g.save();
  g.translate(330, 220);
  g.rotate(-0.08);
  g.fillStyle = '#b9b6a8';
  rr(g, -250, -120, 500, 240, 10); g.fill();
  g.strokeStyle = 'rgba(80,80,70,.35)';
  g.lineWidth = 2;
  rr(g, -236, -106, 472, 212, 8); g.stroke();
  g.fillStyle = '#8c8a7c';
  g.beginPath(); g.arc(-20, 0, 64, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#5b5a50';
  g.font = '800 72px system-ui, sans-serif';
  g.fillText('500', 90, 70);
  g.font = '700 40px system-ui, sans-serif';
  g.fillText('₹', 110, -40);
  g.fillText('500', -220, -50);
  g.restore();
  g.fillStyle = '#b98a6a';
  rr(g, 60, 330, 120, 70, 34); g.fill();
}

function finish(g: G) {
  // vignette
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,.45)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  // sensor noise
  const n = document.createElement('canvas');
  n.width = 160;
  n.height = 120;
  const ng = n.getContext('2d')!;
  const img = ng.createImageData(160, 120);
  for (let i = 0; i < img.data.length; i += 4) {
    const r = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = r;
    img.data[i + 3] = 17;
  }
  ng.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(n, 0, 0, W, H);
  // timestamp overlay, like the real firmware adds
  const ts = new Date().toLocaleTimeString('en-GB');
  g.font = '600 15px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.fillText(`SS-4F2A  ${ts}`, 16, H - 16);
}

export function renderFrame(scene: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  [scene0, scene1, scene2, scene3][Math.max(0, Math.min(3, scene))](g);
  finish(g);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.74),
  );
}
