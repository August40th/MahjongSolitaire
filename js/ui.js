'use strict';
/* =====================================================================================================
   Mahjong Solitaire - screens, drawing and input (canvas). Everything on screen is a copy of the Python
   version: same positions, colours, buttons and hot keys. Browser differences: files are picked with the
   browser's file chooser and saved as downloads, settings live in localStorage, and QUIT is FULLSCREEN.
   ===================================================================================================== */

const FPS_FONT = 'Helvetica, Arial, sans-serif';
const FONT_K = 0.69;                         // pygame's default font size -> CSS pixels
const MIN_W = 1280, MIN_H = 720;             // below this the whole picture is scaled down to fit
const SETTINGS_KEY = 'mahjong_settings';
const NOTE_MS = 2800;

const MUS_ROWS = [
  ['Lowest octave', 'oct_lo', (v, p) => `${v}   (lowest note ${MUSIC.musicNoteName(MUSIC.musicPitches(p)[0])})`],
  ['Number of octaves', 'oct_n', (v, p) => { const a = MUSIC.musicPitches(p); return `${v}   (highest note ${MUSIC.musicNoteName(a[a.length - 1])})`; }],
  ['Note density', 'density', (v) => `${v} / 15   (aims for ${(1.0 / (9.0 * Math.pow(0.78, v - 1))).toFixed(1)} notes a second)`],
  ['Chance of long notes', 'long', (v) => `${v * 10} %`],
  ['Most notes at once', 'voices', (v) => `${v}`],
  ['Volume', 'vol', (v) => `${v} / 10`],
  null,
  ['Reverb amount', 'rev_mix', (v) => `${v} / 10`],
  ['Reverb length', 'rev_len', (v) => `${v} / 10`],
  ['Echo amount', 'dly_mix', (v) => `${v} / 10`],
  ['Echo time', 'dly_time', (v) => `${(0.12 + 0.075 * v).toFixed(2)} s`],
  ['Phaser amount', 'pha_mix', (v) => `${v} / 10`],
  ['Phaser speed', 'pha_rate', (v) => `${(0.05 + 0.09 * v).toFixed(2)} Hz`],
  ['Flanger amount', 'fla_mix', (v) => `${v} / 10`],
  ['Flanger speed', 'fla_rate', (v) => `${(0.04 + 0.05 * v).toFixed(2)} Hz`],
];

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };

function loadSettings() {
  try { const d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); return d && typeof d === 'object' ? d : {}; }
  catch (e) { return {}; }
}
function saveSettings(d) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(d)); } catch (e) { /* private mode */ } }

/* ---------------------------------------------------------------- browser file helpers */
function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept || '';
    inp.multiple = !!multiple;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    const done = (files) => { inp.remove(); resolve(files); };
    inp.addEventListener('change', () => done(Array.from(inp.files || [])));
    inp.addEventListener('cancel', () => done([]));
    inp.click();
  });
}
function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(file); });
const readDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
const loadImage = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not an image')); i.src = url; });

/* ---------------------------------------------------------------- pictures */
function imageToCanvas(img) {
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
/* clockwise rotation (0/90/180/270) of a canvas */
function rotateCanvas(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return src;
  const sw = src.width, sh = src.height;
  const c = (deg === 180) ? makeCanvas(sw, sh) : makeCanvas(sh, sw);
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate(deg * Math.PI / 180);
  g.drawImage(src, -sw / 2, -sh / 2);
  return c;
}

/* One picture in the tileset editor's gallery (max 18). */
class ImageEntry {
  constructor(name, base, dataUrl) {
    this.name = name;
    this.base = base;              // canvas, unrotated
    this.dataUrl = dataUrl;        // the original file, kept for SAVE
    this.rotation = 0;             // clockwise degrees
    this.crop = null;              // [x, y, w, h] in ROTATED-image coordinates
    this._rot = null;
    this._thumb = null;
  }
  surface() {
    if (this.rotation === 0) return this.base;
    if (!this._rot || this._rot[0] !== this.rotation) this._rot = [this.rotation, rotateCanvas(this.base, this.rotation)];
    return this._rot[1];
  }
  thumb(box) {
    const key = this.rotation + '|' + box;
    if (!this._thumb || this._thumb[0] !== key) {
      const s = this.surface();
      const f = Math.min(box / s.width, box / s.height);
      const c = makeCanvas(Math.max(1, Math.floor(s.width * f)), Math.max(1, Math.floor(s.height * f)));
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(s, 0, 0, c.width, c.height);
      this._thumb = [key, c];
    }
    return this._thumb[1];
  }
  /* rotate by a multiple of 90 (positive = clockwise); the crop box follows the picture */
  rotate(deltaCw) {
    const steps = (((deltaCw / 90) % 4) + 4) % 4;
    for (let i = 0; i < steps; i++) {
      const h = this.surface().height;
      if (this.crop) {
        const [x, y, cw, ch] = this.crop;
        this.crop = [h - (y + ch), x, ch, cw];
      }
      this.rotation = (this.rotation + 90) % 360;
    }
  }
}

/* One custom picture used for every tile of a kind+value. */
class CustomTile {
  constructor(kind, value, entry) {
    this.kind = kind; this.value = value;
    this.name = entry.name; this.dataUrl = entry.dataUrl;
    this.base = entry.base;
    this.crop = entry.crop ? entry.crop.slice() : null;
    this.rotation = entry.rotation || 0;
    this.surface = null;
  }
  load() {
    this.surface = null;
    try {
      let img = rotateCanvas(this.base, this.rotation);
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (this.crop) {
        let [x, y, w, h] = this.crop.map(Math.trunc);
        x = Math.max(0, Math.min(x, img.width - 1));
        y = Math.max(0, Math.min(y, img.height - 1));
        w = Math.max(1, Math.min(w, img.width - x));
        h = Math.max(1, Math.min(h, img.height - y));
        sx = x; sy = y; sw = w; sh = h;
      }
      const c = makeCanvas((TILE_W - TILE_INSET) * 2, (TILE_H - TILE_INSET) * 2);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      this.surface = c;
      return true;
    } catch (e) { return false; }
  }
}

class Button {
  constructor(x, y, w, h, text, cb, size = 28, fill = null) {
    this.rect = { x, y, w, h };
    this.text = text; this.cb = cb; this.size = size; this.fill = fill;
  }
  draw(g, hov) {
    const r = this.rect;
    let col;
    if (this.fill) col = hov ? rgb(this.fill.map(c => Math.min(255, c + 28))) : rgb(this.fill);
    else col = hov ? 'rgb(110,110,160)' : 'rgb(80,80,120)';
    g.fillStyle = col;
    rrect(g, r.x, r.y, r.w, r.h, 8); g.fill();
    g.strokeStyle = 'rgb(255,215,60)'; g.lineWidth = 2;
    rrect(g, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 7); g.stroke();
    text(g, this.text, r.x + r.w / 2, r.y + r.h / 2, this.size, '#fff', 'center');
  }
  click(x, y) { if (inRect(this.rect, x, y)) { if (this.cb) this.cb(); return true; } return false; }
}

function rrect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/* text: pygame font size -> CSS font; align left | center | midleft handled by 'align' */
function text(g, s, x, y, size, color, align, bold) {
  g.font = `${bold ? 'bold ' : ''}${Math.max(6, Math.round(size * FONT_K))}px ${FPS_FONT}`;
  g.fillStyle = color;
  g.textAlign = align === 'center' ? 'center' : 'left';
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}
function strokeInside(g, r, w, color, radius) {          // pygame draws a border inside the rectangle
  g.strokeStyle = color; g.lineWidth = w;
  rrect(g, r.x + w / 2, r.y + w / 2, r.w - w, r.h - w, Math.max(0, radius - w / 2)); g.stroke();
}

/* ================================================================================================= game */
class Game extends GameCore {
  constructor(canvas) {
    super({ now: () => performance.now(), width: MIN_W, height: MIN_H });
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.uiScale = 1;
    this.mx = -1; this.my = -1;
    this.cam = { z: 1, x: 0, y: 0 };
    this.pointers = new Map();
    this.gesture = null;
    this.touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    this.editRemove = false; this.halfStep = false; this.editBtns = null;
    this.fitBtn = new Button(0, 0, 80, 40, 'FIT', () => this.resetCam(), 22, [42, 48, 66]);
    this.mode = 'menu';
    this.buttons = [];
    this.faces = new Map();
    this.fullscreenOk = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

    // layout editor
    this.editorLayer = 0;
    // tileset editor
    this.images = [];
    this.imageIndex = 0;
    this.dragStart = null; this.dragNow = null;
    this.assignBtn = null;
    this.selKind = 'letter'; this.selValue = 'A';

    // music
    this.settings = loadSettings();
    this.music = new MusicPlayer(this.settings.music);
    this.musicToggleBtn = null;
    this.musicInstBtns = [];
    this.musicButtons = [];
    this.audioWanted = this.music.p.on;           // the browser only lets sound start after a click / key
    this.errSeen = '';

    this.resize();
    this.showMenu();
  }

  canPlay() { return this.mode === 'game'; }

  /* ---------------------------------------------------------- size */
  /* Each screen has a design size; on a smaller window the whole screen is scaled down to fit (and can be
     pinched larger). The game screen has real phone layouts instead (see layoutMode). */
  minSize() {
    switch (this.mode) {
      case 'menu': return [600, 620];
      case 'music': return [960, 720];
      case 'tileset': return [MIN_W, MIN_H];
      case 'editor': return [700, 520];
      default: return [340, 300];
    }
  }
  camKind() { return (this.mode === 'game' || this.mode === 'editor') ? 'board' : 'screen'; }
  layoutMode() {
    if (this.WIDTH >= 900 && this.HEIGHT >= 600) return 'desktop';
    return this.WIDTH >= this.HEIGHT * 1.15 ? 'landscape' : 'portrait';
  }
  /* A phone held upright shows the game turned on its side (the page is always landscape). */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth, ch = window.innerHeight;
    this.rotated = this.touch && ch > cw;
    this.vw = cw;
    const lw = this.rotated ? ch : cw, lh = this.rotated ? cw : ch;
    this.canvas.width = Math.floor(lw * dpr);
    this.canvas.height = Math.floor(lh * dpr);
    const st = this.canvas.style;
    st.position = 'fixed'; st.left = '0'; st.top = '0';
    st.width = lw + 'px'; st.height = lh + 'px';
    st.transformOrigin = '0 0';
    st.transform = this.rotated ? `translate(${cw}px, 0) rotate(90deg)` : 'none';
    this.cssW = lw; this.cssH = lh; this.dpr = dpr;
    this.refit();
  }
  refit() {
    const [mw, mh] = this.minSize();
    this.uiScale = Math.min(1, this.cssW / mw, this.cssH / mh);
    this.WIDTH = Math.floor(this.cssW / this.uiScale);
    this.HEIGHT = Math.floor(this.cssH / this.uiScale);
    this.pxScale = this.dpr * this.uiScale;
    this.fitBtn.rect.x = this.WIDTH - 90;
    this.fitBtn.rect.y = this.HEIGHT - 52;
    this.resetCam();
    this.rebuildUI();
  }
  rebuildUI() {
    this.topMargin = this.bottomMargin = this.leftMargin = this.rightMargin = undefined;
    // In the game each tile is a thick block and every layer is raised by one tile thickness; the editor shifts layers further so you can see them.
    this.layerDx = this.mode === 'game' ? TILE_DEPTH : LAYER_DX;
    this.layerDy = this.mode === 'game' ? TILE_DEPTH : LAYER_DY;
    this.tileInset = this.mode === 'game' ? 0 : TILE_INSET;
    switch (this.mode) {
      case 'menu': this.buildMenu(); break;
      case 'game': this.buildGameUI(); this.recalculateView(); break;
      case 'editor': this.buildEditorUI(); break;
      case 'tileset': this.buildTilesetUI(); break;
      case 'music': this.buildMusicUI(); break;
    }
  }

  /* ---------------------------------------------------------- zoom and pan (pinch) */
  resetCam() { this.cam = { z: 1, x: 0, y: 0 }; }
  toWorld(x, y) { const c = this.cam; return [(x - c.x) / c.z, (y - c.y) / c.z]; }
  buttonPt(x, y) { return this.camKind() === 'screen' ? this.toWorld(x, y) : [x, y]; }
  clampCam() {
    const c = this.cam;
    c.z = Math.max(1, Math.min(8, c.z));
    if (c.z < 1.001) c.z = 1;
    c.x = Math.max(this.WIDTH * (1 - c.z), Math.min(0, c.x));
    c.y = Math.max(this.HEIGHT * (1 - c.z), Math.min(0, c.y));
  }
  zoomAt(x, y, nz) {
    const c = this.cam;
    const wx = (x - c.x) / c.z, wy = (y - c.y) / c.z;
    c.z = nz; c.x = x - wx * nz; c.y = y - wy * nz;
    this.clampCam();
  }

  /* ---------------------------------------------------------- tile faces */
  face(kind, value, color) {
    const key = kind + value + color;
    let c = this.faces.get(key);
    if (c) return c;
    const S = 2;                                   // drawn at double size so zooming in stays sharp
    const w = (TILE_W - TILE_INSET) * S, h = (TILE_H - TILE_INSET) * S;
    c = makeCanvas(w, h);
    const g = c.getContext('2d');
    g.font = `${Math.round(66 * 0.72 * S)}px ${FPS_FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const cx = w / 2, cy = h / 2 + 2 * S;
    g.fillStyle = '#fff';
    for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]]) g.fillText(value, cx + dx * S, cy + dy * S);
    g.fillStyle = rgb(COLORS[color]);
    g.fillText(value, cx, cy);
    this.faces.set(key, c);
    return c;
  }

  /* ---------------------------------------------------------- screens */
  showMenu() {
    this.mode = 'menu';
    this.pending = []; this.locked = false;
    this.dragStart = this.dragNow = null;
    this.refit();
  }
  buildMenu() {
    const cx = Math.floor(this.WIDTH / 2);
    this.menuTitleY = Math.max(70, Math.floor(this.HEIGHT * 0.20));
    const top = this.menuTitleY + 52 + 70, step = 70;
    this.musicButtons = [];
    const items = [
      ['PLAY', () => this.startGame()],
      ['LAYOUT EDITOR', () => this.startLayoutEditor()],
      ['TILESET EDITOR', () => this.startTilesetEditor()],
      ['MUSIC', () => this.showMusicUI()],
    ];
    if (this.fullscreenOk) items.push(['FULLSCREEN', () => this.toggleFullscreen()]);
    this.buttons = items.map(([t, cb], i) => new Button(cx - 150, top + step * i, 300, 55, t, cb));
  }
  toggleFullscreen() {
    const el = document.documentElement;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else {
        const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
        if (p && p.then) p.then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* ignore */ } }).catch(() => {});
      }
    } catch (e) { this.notify('Fullscreen is not available'); }
  }

  startGame() { this.mode = 'game'; this.refit(); this.newDeal(); }
  /* Always the landscape layout: buttons in a column on the left, the numbers and the matched-pair tray
     on the right, the board in the middle. */
  gameBig() { return this.WIDTH >= 900 && this.HEIGHT >= 600; }
  buildGameUI() {
    this.musicButtons = [];
    const big = this.gameBig(), H = this.HEIGHT;
    const sz = big ? 26 : 22, bw = big ? 170 : 104, bh = big ? 52 : 38, gap = big ? 10 : 6, x = big ? 20 : 8, y0 = big ? 20 : 8;
    const items = [['MENU', () => this.showMenu()], ['FIND', () => this.findMove()], ['UNDO', () => this.undoMove()],
                   ['SHUFFLE', () => this.reshuffle()], ['NEW', () => this.newDeal()]];
    this.buttons = items.map(([t, cb], i) => new Button(x, y0 + i * (bh + gap), bw, bh, t, cb, sz));
    const mb = new Button(x, y0 + 5 * (bh + gap), bw, bh, '', () => this.toggleMusic(), sz);
    this.musicButtons.push(mb);
    this.buttons.push(mb);
    this.leftMargin = x + bw + 20; this.rightMargin = big ? 290 : 190; this.topMargin = 20; this.bottomMargin = 20;
    this.refreshMusicLabels();
  }
  startLayoutEditor() {
    this.mode = 'editor';
    if (!this.layoutData) this.layoutData = LAYOUTS[this.layoutName]().map(c => c.slice());
    this.editorLayer = 0;
    this.refit();
  }
  changeLayer(d) { this.editorLayer = Math.max(0, Math.min(EDITOR_MAX_LAYER, this.editorLayer + d)); }
  buildEditorUI() {
    const W = this.WIDTH, H = this.HEIGHT;
    const compact = this.touch || this.layoutMode() !== 'desktop';
    if (compact) { this.topMargin = 125; this.bottomMargin = 72; this.leftMargin = 8; this.rightMargin = 8; }
    this.setView(EDITOR_COLS[0], EDITOR_COLS[1], EDITOR_ROWS[0], EDITOR_ROWS[1], EDITOR_MAX_LAYER);
    this.buttons = [
      new Button(30, 30, 110, 42, 'MENU', () => this.showMenu()),
      new Button(W - 355, 30, 105, 42, 'RESET', () => this.resetLayout()),
      new Button(W - 240, 30, 105, 42, 'SAVE', () => this.saveLayout()),
      new Button(W - 125, 30, 105, 42, 'LOAD', () => this.loadLayout()),
    ];
    this.editBtns = null;
    if (compact) {                                         // what the mouse does with wheel, right-click and SHIFT
      const y = H - 58, h = 42;
      this.editBtns = {
        down: new Button(10, y, 110, h, 'LAYER -', () => this.changeLayer(-1), 24),
        up: new Button(128, y, 110, h, 'LAYER +', () => this.changeLayer(1), 24),
        mode: new Button(246, y, 150, h, '', () => { this.editRemove = !this.editRemove; }, 24),
        half: new Button(404, y, 170, h, '', () => { this.halfStep = !this.halfStep; }, 24),
      };
      this.buttons.push(...Object.values(this.editBtns));
    }
  }
  startTilesetEditor() { this.mode = 'tileset'; this.dragStart = this.dragNow = null; this.refit(); }
  buildTilesetUI() {
    const W = this.WIDTH;
    this.assignBtn = new Button(890, 88, 190, 42, 'ASSIGN', () => this.assignCrop());
    this.buttons = [
      new Button(30, 30, 110, 42, 'MENU', () => this.showMenu()),
      new Button(W - 570, 30, 170, 42, 'ADD IMAGES', () => this.addImages()),
      new Button(W - 390, 30, 170, 42, 'REMOVE IMAGE', () => this.removeImage()),
      new Button(W - 210, 30, 90, 42, 'SAVE', () => this.saveTs()),
      new Button(W - 110, 30, 90, 42, 'OPEN', () => this.loadTs()),
      new Button(420, 88, 50, 42, '<', () => this.prevImage()),
      new Button(476, 88, 50, 42, '>', () => this.nextImage()),
      new Button(540, 88, 160, 42, 'ROTATE LEFT', () => this.rotateLeft()),
      new Button(710, 88, 170, 42, 'ROTATE RIGHT', () => this.rotateRight()),
      this.assignBtn,
      new Button(1090, 88, 160, 42, 'CLEAR VALUE', () => this.clearValue()),
    ];
  }

  /* ---------------------------------------------------------- music */
  refreshMusicLabels() {
    const t = this.music.p.on ? 'MUSIC: ON' : 'MUSIC: OFF';
    for (const b of this.musicButtons) b.text = t;
  }
  musicProblem() {
    const mu = this.music;
    if (!mu.available) return "This browser can't play the music (it needs AudioWorklet).";
    if (mu.error) return 'Sound problem: ' + mu.error;
    return '';
  }
  saveMusicSettings() { this.settings.music = Object.assign({}, this.music.p); saveSettings(this.settings); }
  toggleMusic() {
    const mu = this.music;
    const on = !mu.p.on;
    mu.set({ on });
    this.audioWanted = false;
    if (on) {
      this.notify('Music on');
      mu.start().then(() => { const p = this.musicProblem(); if (p) this.notify(p); });
    } else {
      mu.stop();
      this.notify('Music off');
    }
    this.refreshMusicLabels();
    this.saveMusicSettings();
  }
  /* The first tap, click or key press of the visit: browsers only allow sound after one. */
  unlockAudio() {
    if (this.touch && !this.lockTried) {
      this.lockTried = true;
      try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* only some browsers allow it */ }
    }
    if (!this.audioWanted) return;
    if (!this.music.p.on) { this.audioWanted = false; return; }
    this.music.start().then((ok) => { if (ok || this.music.error) this.audioWanted = false; });
  }

  musicGeometry() {
    const cx = Math.floor(this.WIDTH / 2);
    const oy = Math.max(0, Math.floor((this.HEIGHT - 780) / 2));
    const step = this.HEIGHT >= 720 ? 29 : Math.max(20, Math.floor((this.HEIGHT - 330) / 14));
    const toggleY = 96 + oy, instY = toggleY + 40;
    let y = instY + 42;
    const rows = [];
    for (const row of MUS_ROWS) { rows.push([row, y]); y += row === null ? 22 : step; }
    return { cx, oy, x0: cx - 330, toggleY, instY, rows, endY: y + 8, pmH: Math.min(24, step - 2) };
  }
  showMusicUI() { this.mode = 'music'; this.refit(); }
  buildMusicUI() {
    this.musicButtons = [];
    const g = this.musicGeometry(), x0 = g.x0, grey = [42, 48, 66];
    this.musicToggleBtn = new Button(x0, g.toggleY, 140, 30, '', () => this.toggleMusic(), 24, grey);
    const btns = [this.musicToggleBtn];
    this.musicInstBtns = [];
    MUSIC.MUS_INSTRUMENTS.forEach((nm, q) => {
      const b = new Button(x0 + 190 + q * 112, g.instY, 106, 30, nm, () => this.setInstrument(nm), 22, grey);
      btns.push(b); this.musicInstBtns.push([b, nm]);
    });
    for (const [row, y] of g.rows) {
      if (row === null) continue;
      const key = row[1];
      btns.push(new Button(x0 + 190, y, 28, g.pmH, '-', () => this.adjustMusic(key, -1), 26, grey));
      btns.push(new Button(x0 + 434, y, 28, g.pmH, '+', () => this.adjustMusic(key, 1), 26, grey));
    }
    btns.push(new Button(x0, g.endY, 200, 32, 'Reset to defaults', () => this.resetMusic(), 24, grey));
    btns.push(new Button(x0 + 460, g.endY, 200, 32, 'Back  [Esc]', () => this.showMenu(), 24, [45, 106, 58]));
    this.buttons = btns;
  }
  setInstrument(n) { this.music.set({ inst: n }); this.saveMusicSettings(); }
  adjustMusic(key, d) { this.music.set({ [key]: this.music.p[key] + d }); this.saveMusicSettings(); }
  resetMusic() { this.music.set(Object.assign({}, MUSIC.MUS_DEFAULTS, { on: this.music.p.on })); this.saveMusicSettings(); }
  musicScreenNotes() {
    const mu = this.music;
    if (!mu.available) return ["This browser can't play the music (it needs AudioWorklet support)."];
    if (mu.error) return ['Sound problem: ' + mu.error];
    return [];
  }

  /* ---------------------------------------------------------- layout editor */
  editorClick(x, y, remove, half) {
    if (!this.layoutData) return;
    if (remove) {
      const cells = this.layoutData.slice().sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]) || (b[0] - a[0]));
      for (const c of cells) {
        if (inRect(this.cellRect(c[0], c[1], c[2]), x, y)) {
          this.layoutData.splice(this.layoutData.indexOf(c), 1);
          this.layoutEdited = true;
          return;
        }
      }
      return;
    }
    const z = this.editorLayer, s = this.scale;
    const fx = (x - this.offsetX - z * this.layerDx * s) / (TILE_W * s) + this.originGx;
    const fy = (y - this.offsetY + z * this.layerDy * s) / (TILE_H * s) + this.originGy;
    const step = half ? 0.5 : 1.0;
    const pyRound = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : (d < 0.5 ? f : (f % 2 === 0 ? f : f + 1)); };
    let gx = pyRound((fx - 0.47) / step) * step;
    let gy = pyRound((fy - 0.47) / step) * step;
    gx = Math.max(EDITOR_COLS[0], Math.min(EDITOR_COLS[1], gx));
    gy = Math.max(EDITOR_ROWS[0], Math.min(EDITOR_ROWS[1], gy));
    if (!this.layoutData.some(c => c[0] === gx && c[1] === gy && c[2] === z)) {
      this.layoutData.push([gx, gy, z]);
      this.layoutEdited = true;
    }
  }
  resetLayout() {
    this.layoutData = LAYOUTS[this.layoutName]().map(c => c.slice());
    this.layoutEdited = false;
    this.notify('Layout reset to Exact Turtle');
  }
  saveLayout() { downloadText('layout.json', JSON.stringify(this.layoutData)); this.notify('Layout saved (downloaded layout.json)'); }
  async loadLayout() {
    const [f] = await pickFiles('.json,application/json', false);
    if (!f) return;
    try {
      const data = JSON.parse(await readText(f));
      const cells = data.map(c => [Number(c[0]), Number(c[1]), Math.trunc(Number(c[2]))]);
      if (!cells.length) throw new Error('file contains no tiles');
      if (cells.some(c => c.some(v => !isFinite(v)))) throw new Error('bad numbers in file');
      this.layoutData = cells;
      this.layoutEdited = true;
      this.notify('Layout loaded.');
    } catch (e) { this.notify('Could not load layout: ' + e.message); }
  }

  /* ---------------------------------------------------------- tileset editor */
  cur() {
    if (!this.images.length) return null;
    this.imageIndex = Math.max(0, Math.min(this.imageIndex, this.images.length - 1));
    return this.images[this.imageIndex];
  }
  nextImage() { if (this.images.length) { this.imageIndex = (this.imageIndex + 1) % this.images.length; this.dragStart = this.dragNow = null; } }
  prevImage() { if (this.images.length) { this.imageIndex = (this.imageIndex - 1 + this.images.length) % this.images.length; this.dragStart = this.dragNow = null; } }
  rotateLeft() {
    const e = this.cur();
    if (!e) { this.notify('Add an image first'); return; }
    e.rotate(-90); this.dragStart = this.dragNow = null; this.notify(`Rotated left - now ${e.rotation} deg`);
  }
  rotateRight() {
    const e = this.cur();
    if (!e) { this.notify('Add an image first'); return; }
    e.rotate(90); this.dragStart = this.dragNow = null; this.notify(`Rotated right - now ${e.rotation} deg`);
  }
  paletteBoxes() {
    const boxes = [];
    const x0 = 30, y0 = 150, bw = 52, bh = 38, gap = 4, cols = 6;
    TILE_TYPES.letter.forEach((v, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      boxes.push([{ x: x0 + c * (bw + gap), y: y0 + r * (bh + gap), w: bw, h: bh }, 'letter', v]);
    });
    const rowsL = Math.ceil(TILE_TYPES.letter.length / cols);
    const y1 = y0 + rowsL * (bh + gap) + 40;
    TILE_TYPES.digit.forEach((v, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      boxes.push([{ x: x0 + c * (bw + gap), y: y1 + r * (bh + gap), w: bw, h: bh }, 'digit', v]);
    });
    const rowsD = Math.ceil(TILE_TYPES.digit.length / cols);
    return { boxes, labL: y0 - 24, labD: y1 - 24, prevY: y1 + rowsD * (bh + gap) + 40 };
  }
  thumbRects() {
    const n = this.images.length;
    if (!n) return [];
    const avail = this.WIDTH - 420 - 30;
    const box = Math.max(24, Math.min(56, Math.floor(avail / MAX_IMAGES) - 4));
    return this.images.map((_, i) => [{ x: 420 + i * (box + 4), y: 162, w: box, h: box }, i]);
  }
  tilesetView() {
    const e = this.cur();
    if (!e) return null;
    const s = e.surface(), iw = s.width, ih = s.height;
    const dx = 420, dy = 228;
    const aw = Math.max(50, this.WIDTH - dx - 30), ah = Math.max(50, this.HEIGHT - dy - 80);
    const f = Math.min(aw / iw, ah / ih, 3.0);
    return { dx, dy, f, dw: Math.max(1, Math.floor(iw * f)), dh: Math.max(1, Math.floor(ih * f)) };
  }
  tilesetPress(x, y) {
    for (const [r, kind, val] of this.paletteBoxes().boxes) if (inRect(r, x, y)) { this.selKind = kind; this.selValue = val; return; }
    for (const [r, idx] of this.thumbRects()) if (inRect(r, x, y)) { this.imageIndex = idx; this.dragStart = this.dragNow = null; return; }
    const v = this.tilesetView();
    if (v && inRect({ x: v.dx, y: v.dy, w: v.dw, h: v.dh }, x, y)) { this.dragStart = [x, y]; this.dragNow = [x, y]; }
  }
  tilesetMotion(x, y) { if (this.dragStart) this.dragNow = [x, y]; }
  tilesetRelease(x, y) {
    if (!this.dragStart) return;
    const [x0, y0] = this.dragStart;
    this.dragStart = this.dragNow = null;
    const v = this.tilesetView(), e = this.cur();
    if (!v || !e) return;
    const s = e.surface(), iw = s.width, ih = s.height;
    const cl = (val, hi) => Math.max(0, Math.min(hi, val));
    const ix0 = cl((Math.min(x0, x) - v.dx) / v.f, iw), iy0 = cl((Math.min(y0, y) - v.dy) / v.f, ih);
    const ix1 = cl((Math.max(x0, x) - v.dx) / v.f, iw), iy1 = cl((Math.max(y0, y) - v.dy) / v.f, ih);
    const w = ix1 - ix0, h = iy1 - iy0;
    if (w >= 4 && h >= 4) {
      e.crop = [Math.trunc(ix0), Math.trunc(iy0), Math.trunc(w), Math.trunc(h)];
      this.notify('Crop set - pick a letter/digit, then ASSIGN');
    }
  }
  assignCrop() {
    const e = this.cur();
    if (!e) { this.notify('Add an image first (ADD IMAGES)'); return; }
    const t = new CustomTile(this.selKind, this.selValue, e);
    if (t.load()) {
      this.customTs[this.selKind][this.selValue] = t;
      this.notify(`Assigned ${e.crop ? 'crop' : 'whole image'} to ${this.selKind} ${this.selValue}`);
    } else this.notify('Could not load that image region');
  }
  clearValue() {
    if (this.customTs[this.selKind][this.selValue]) {
      delete this.customTs[this.selKind][this.selValue];
      this.notify(`Cleared ${this.selKind} ${this.selValue}`);
    } else this.notify('Nothing assigned to that value');
  }
  async addImages() {
    const room = MAX_IMAGES - this.images.length;
    if (room <= 0) { this.notify(`${MAX_IMAGES} image limit reached - REMOVE IMAGE first`); return; }
    let files = await pickFiles('image/*,.png,.jpg,.jpeg,.bmp,.gif,.webp', true);
    if (!files.length) return;
    const skipped = Math.max(0, files.length - room);
    files = files.slice(0, room);
    const first = this.images.length;
    let failed = 0;
    for (const f of files) {
      try {
        const url = await readDataUrl(f);
        const img = await loadImage(url);
        this.images.push(new ImageEntry(f.name, imageToCanvas(img), url));
      } catch (e) { failed++; }
    }
    const added = this.images.length - first;
    if (added) { this.imageIndex = first; this.dragStart = this.dragNow = null; }
    let msg = `Added ${added} image${added !== 1 ? 's' : ''}`;
    if (skipped) msg += ` (${skipped} skipped - limit ${MAX_IMAGES})`;
    if (failed) msg += ` (${failed} could not be read)`;
    this.notify(msg);
  }
  removeImage() {
    const e = this.cur();
    if (!e) { this.notify('No image to remove'); return; }
    this.images.splice(this.imageIndex, 1);
    this.imageIndex = Math.max(0, Math.min(this.imageIndex, this.images.length - 1));
    this.dragStart = this.dragNow = null;
    this.notify('Removed ' + e.name);
  }
  /* The tileset file carries its pictures inside (a browser cannot read files by path). */
  saveTs() {
    const data = { images: {}, letter: {}, digit: {} };
    const keyOf = new Map();
    for (const kind of KINDS) {
      for (const [v, t] of Object.entries(this.customTs[kind])) {
        if (!keyOf.has(t.dataUrl)) { const k = 'img' + keyOf.size; keyOf.set(t.dataUrl, k); data.images[k] = t.dataUrl; }
        data[kind][v] = { path: t.name, image: keyOf.get(t.dataUrl), crop: t.crop, rotation: t.rotation };
      }
    }
    downloadText('tileset.json', JSON.stringify(data));
    this.notify('Tileset saved (downloaded tileset.json)');
  }
  async loadTs() {
    const [f] = await pickFiles('.json,application/json', false);
    if (!f) return;
    try {
      const data = JSON.parse(await readText(f));
      const ts = { letter: {}, digit: {} };
      const cache = {};
      let missing = 0;
      for (const kind of KINDS) {
        for (const [v, info] of Object.entries(data[kind] || {})) {
          if (!info || typeof info !== 'object') continue;
          const url = (data.images || {})[info.image];
          if (!url) { missing++; continue; }
          if (!cache[info.image]) cache[info.image] = imageToCanvas(await loadImage(url));
          const entry = { name: info.path || 'image', dataUrl: url, base: cache[info.image], crop: info.crop, rotation: info.rotation || 0 };
          const t = new CustomTile(kind, v, entry);
          t.load();
          ts[kind][v] = t;
        }
      }
      this.customTs = ts;
      this.notify(missing ? `Tileset loaded (${missing} entries had no picture inside the file)` : 'Tileset loaded.');
    } catch (e) { this.notify('Could not load tileset: ' + e.message); }
  }

  /* ---------------------------------------------------------- input */
  toLocal(e) {
    if (this.rotated) return [e.clientY / this.uiScale, (this.vw - e.clientX) / this.uiScale];
    return [e.clientX / this.uiScale, e.clientY / this.uiScale];
  }
  /* A click or tap at screen position (x, y). */
  press(x, y, button, shift) {
    if (this.cam.z > 1.01 && inRect(this.fitBtn.rect, x, y)) { this.resetCam(); return; }
    const [bx, by] = this.buttonPt(x, y);
    if (this.buttons.slice().some(b => b.click(bx, by))) return;
    const [wx, wy] = this.toWorld(x, y);
    if (button === 0) {
      if (this.mode === 'game') { const t = this.tileAt(wx, wy); if (t) this.clickTile(t); }
      else if (this.mode === 'editor') this.editorClick(wx, wy, this.editRemove, shift || this.halfStep);
      else if (this.mode === 'tileset') this.tilesetPress(wx, wy);
    } else if (button === 2 && this.mode === 'editor') this.editorClick(wx, wy, true, false);
  }
  onPointerDown(e) {
    this.unlockAudio();
    const [x, y] = this.toLocal(e);
    if (e.pointerType !== 'mouse' && !this.touch) { this.touch = true; this.rebuildUI(); }
    if (e.pointerType === 'mouse') { this.mx = x; this.my = y; this.press(x, y, e.button, e.shiftKey); return; }
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* not needed */ }
    const p = { x, y, sx: x, sy: y, moved: false, crop: false, gest: false };
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {                          // two fingers: pinch to zoom, drag to move
      this.dragStart = this.dragNow = null;
      const [a, b] = Array.from(this.pointers.values());
      a.gest = b.gest = true;
      this.gesture = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.cam.z, last: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
      return;
    }
    if (this.pointers.size > 2) { p.gest = true; return; }
    if (this.mode === 'tileset') {                           // one finger on the picture draws the crop box
      const v = this.tilesetView();
      const [bx, by] = this.buttonPt(x, y), [wx, wy] = this.toWorld(x, y);
      if (v && !this.buttons.some(b => inRect(b.rect, bx, by)) && inRect({ x: v.dx, y: v.dy, w: v.dw, h: v.dh }, wx, wy)) {
        p.crop = true; this.tilesetPress(wx, wy);
      }
    }
  }
  onPointerMove(e) {
    const [x, y] = this.toLocal(e);
    if (e.pointerType === 'mouse') {
      this.mx = x; this.my = y;
      if (this.mode === 'tileset') { const [wx, wy] = this.toWorld(x, y); this.tilesetMotion(wx, wy); }
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (this.gesture && this.pointers.size >= 2) {
      const [a, b] = Array.from(this.pointers.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = [(a.x + b.x) / 2, (a.y + b.y) / 2], gs = this.gesture;
      this.cam.x += mid[0] - gs.last[0]; this.cam.y += mid[1] - gs.last[1];
      this.zoomAt(mid[0], mid[1], gs.z0 * d / gs.d0);
      gs.last = mid;
      return;
    }
    if (Math.hypot(x - p.sx, y - p.sy) > 10) p.moved = true;
    if (p.crop) { const [wx, wy] = this.toWorld(x, y); this.tilesetMotion(wx, wy); return; }
    if (p.moved && !p.gest && this.cam.z > 1.001) { this.cam.x += dx; this.cam.y += dy; this.clampCam(); }
  }
  onPointerUp(e) {
    const [x, y] = this.toLocal(e);
    if (e.pointerType === 'mouse') {
      if (e.button === 0 && this.mode === 'tileset') { const [wx, wy] = this.toWorld(x, y); this.tilesetRelease(wx, wy); }
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.gesture = null;
    this.mx = this.my = -1;
    if (p.crop) { const [wx, wy] = this.toWorld(x, y); this.tilesetRelease(wx, wy); return; }
    if (!p.moved && !p.gest && e.type !== 'pointercancel') { this.unlockAudio(); this.press(x, y, 0, false); }
  }
  onWheel(e) {
    const [x, y] = this.toLocal(e);
    if (e.ctrlKey) { this.zoomAt(x, y, this.cam.z * Math.exp(-e.deltaY * 0.01)); return; }   // trackpad pinch / Ctrl + wheel
    if (this.mode === 'editor') { this.changeLayer(e.deltaY < 0 ? 1 : -1); return; }
    if (this.cam.z > 1.001) { this.cam.x -= e.deltaX; this.cam.y -= e.deltaY; this.clampCam(); }
  }
  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    this.unlockAudio();
    const k = e.key;
    if (k === 'Escape') { if (this.mode !== 'menu') this.showMenu(); else return false; }
    else if (k === 'm' || k === 'M') this.toggleMusic();
    else if (this.mode === 'game') {
      if (k === 'f' || k === 'F') this.findMove();
      else if (k === 'u' || k === 'U') this.undoMove();
      else if (k === 's' || k === 'S') this.reshuffle();
      else if (k === 'n' || k === 'N') this.newDeal();
      else return false;
    } else if (this.mode === 'editor') {
      if (k === 'ArrowUp') this.changeLayer(1);
      else if (k === 'ArrowDown') this.changeLayer(-1);
      else return false;
    } else if (this.mode === 'tileset') {
      if (k === 'ArrowLeft') this.prevImage();
      else if (k === 'ArrowRight') this.nextImage();
      else if (k === '[') this.rotateLeft();
      else if (k === ']') this.rotateRight();
      else return false;
    } else return false;
    return true;
  }

  /* ---------------------------------------------------------- drawing */
  frame() {
    this.processPending();
    this.draw();
  }
  draw() {
    const g = this.g, c = this.cam, kind = this.camKind();
    g.setTransform(this.pxScale, 0, 0, this.pxScale, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'medium';
    g.fillStyle = 'rgb(30,45,50)';
    g.fillRect(0, 0, this.WIDTH, this.HEIGHT);
    const zoomed = () => { g.save(); g.translate(c.x, c.y); g.scale(c.z, c.z); };
    if (kind === 'screen') zoomed();                       // menu, tileset editor and music: the whole screen zooms
    if (this.mode === 'menu') this.drawMenu();
    else if (this.mode === 'game') { zoomed(); this.drawBoard(); g.restore(); this.drawWon(); this.drawHud(); }
    else if (this.mode === 'editor') { zoomed(); this.drawEditor(); g.restore(); this.drawEditorHud(); }
    else if (this.mode === 'tileset') this.drawTilesetEditor();
    else if (this.mode === 'music') this.drawMusic();

    const err = this.music.error;
    if (err && err !== this.errSeen) { this.errSeen = err; this.notify('Sound problem: ' + err); }

    const [hx, hy] = this.buttonPt(this.mx, this.my);
    for (const b of this.buttons) b.draw(g, inRect(b.rect, hx, hy));
    if (kind === 'screen') g.restore();
    if (c.z > 1.01) this.fitBtn.draw(g, inRect(this.fitBtn.rect, this.mx, this.my));
    if (this.notification && this.now() - this.notificationTime < NOTE_MS) this.drawNotification();
  }
  drawMenu() {
    const g = this.g, ty = this.menuTitleY, cx = this.WIDTH / 2;
    text(g, 'MAHJONG SOLITAIRE', cx, ty, 76, 'rgb(255,215,60)', 'center');
    text(g, 'Exact Turtle layout - A-Z, 0-9 alphanumeric tiles', cx, ty + 52, 30, 'rgb(170,182,174)', 'center');
    if (this.audioWanted && this.music.available) {
      const last = this.buttons[this.buttons.length - 1].rect;
      text(g, `${this.touch ? 'Tap' : 'Click'} anywhere${this.touch ? '' : ' or press a key'} to start the music`, cx, last.y + last.h + 34, 24, 'rgb(170,182,174)', 'center');
    }
  }
  drawHud() {
    const g = this.g, big = this.gameBig();
    const left = this.tiles.filter(t => t.visible).length, moves = this.countMoves(), quads = this.quadValues.size;
    const col = 'rgb(205,212,208)';
    const x = this.WIDTH - (big ? 270 : 180), sz = big ? 26 : 20, step = big ? 27 : 22;
    const lines = [`Layout: ${this.layoutEdited ? 'Custom' : this.layoutName}`, `Tiles left: ${left}`,
                   `Matches available: ${moves}`, `Quadruples: ${quads}`];
    lines.forEach((l, i) => text(g, l, x, (big ? 40 : 22) + i * step, sz, col, 'left'));
    let y = (big ? 40 : 22) + lines.length * step;
    if (big && !this.touch) {
      text(g, 'F find   U undo   S shuffle   N new', x, y, 20, 'rgb(170,182,174)', 'left');
      text(g, 'M music on/off   Esc menu', x, y + 22, 20, 'rgb(170,182,174)', 'left');
      y += 44;
    }
    text(g, 'Matched Pairs', x, y + 14, big ? 22 : 18, 'rgb(205,212,208)', 'left');
    this.drawTray(x, y + (big ? 34 : 28), big ? 252 : 176, big ? 36 : 24);
  }
  /* One copy of every tile whose pair has been cleared once; it goes away when the fourth tile is cleared. */
  drawTray(x0, y0, width, tw) {
    const g = this.g, th = Math.round(tw * 4 / 3), gap = Math.max(4, Math.round(tw / 6));
    const cols = Math.max(1, Math.floor((width + gap) / (tw + gap)));
    this.trayTiles().forEach((t, i) => {
      const r = { x: x0 + (i % cols) * (tw + gap), y: y0 + Math.floor(i / cols) * (th + gap), w: tw, h: th };
      g.fillStyle = BG_DEFAULT; rrect(g, r.x, r.y, r.w, r.h, 4); g.fill();
      g.drawImage(t.customSurface || this.face(t.kind, t.value, t.color), r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      strokeInside(g, r, 2, BORDER_DEFAULT, 4);
    });
  }
  drawBoard() {
    const g = this.g;
    // Drawn layer by layer, right to left and top to bottom, so a tile's neighbour on its left (and the one
    // below) is drawn after it and hides its edge: only the outer edges of a layer stay visible.
    const ordered = this.tiles.slice().sort((a, b) => (a.z - b.z) || (b.gx - a.gx) || (a.gy - b.gy));
    const T = Math.max(2, Math.round(TILE_DEPTH * this.scale));            // tile thickness in pixels
    const poly = (pts, fill) => { g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = fill; g.fill(); };
    for (const t of ordered) {
      if (!t.visible) continue;
      const r = this.tileRect(t);
      // The block: its face is at r; its body reaches T down and to the left, exactly where the face of the
      // tile one layer lower is, so the tiles underneath are covered and only the thick edges show.
      const F = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      const bl = [r.x - T, r.y + T];
      g.fillStyle = 'rgba(0,0,0,0.28)';                                       // soft shadow on what is below
      rrect(g, r.x - T + 2, r.y + T + 3, r.w, r.h, 5); g.fill();
      poly([F[0], F[1], F[2], [r.x + r.w - T, r.y + r.h + T], [bl[0], r.y + r.h + T], bl], 'rgb(150,160,136)');
      poly([F[0], bl, [bl[0], r.y + r.h + T], F[3]], 'rgb(228,228,206)');     // left edge, lit
      poly([F[3], [bl[0], r.y + r.h + T], [r.x + r.w - T, r.y + r.h + T], F[2]], 'rgb(158,172,144)');   // bottom edge, in shade
      g.strokeStyle = 'rgb(84,88,70)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(bl[0] + 0.5, bl[1]); g.lineTo(bl[0] + 0.5, r.y + r.h + T - 0.5); g.lineTo(r.x + r.w - T, r.y + r.h + T - 0.5); g.stroke();
      g.beginPath(); g.moveTo(r.x, r.y + r.h); g.lineTo(bl[0], r.y + r.h + T); g.stroke();
      this.drawTile(t);
    }
  }
  drawWon() {
    if (!this.won) return;
    const g = this.g;
    g.fillStyle = 'rgba(0,0,0,0.686)'; g.fillRect(0, 0, this.WIDTH, this.HEIGHT);
    text(g, 'CLEARED!', this.WIDTH / 2, this.HEIGHT / 2 - 20, 84, 'rgb(255,215,60)', 'center');
    text(g, 'Press NEW for another round', this.WIDTH / 2, this.HEIGHT / 2 + 46, 32, 'rgb(220,226,222)', 'center');
  }
  drawTile(t) {
    const g = this.g, r = this.tileRect(t);
    g.fillStyle = t.bg; rrect(g, r.x, r.y, r.w, r.h, 5); g.fill();
    let art = t.customSurface;
    if (!art) art = this.face(t.kind, t.value, t.color);
    const pad = Math.max(1, Math.trunc(2 * this.scale));
    const iw = r.w - 2 * pad, ih = r.h - 2 * pad;
    if (iw > 2 && ih > 2) g.drawImage(art, r.x + pad, r.y + pad, iw, ih);
    const bw = this.scale < 1 ? Math.max(2, Math.trunc(t.borderWidth * this.scale)) : t.borderWidth;
    strokeInside(g, r, bw, t.border, 5);
  }
  drawEditor() {
    const g = this.g;
    const cells = (this.layoutData || []).slice().sort((a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (a[0] - b[0]));
    for (const c of cells) {
      const r = this.cellRect(c[0], c[1], c[2]);
      g.fillStyle = c[2] === this.editorLayer ? 'rgb(152,156,158)' : 'rgb(74,80,84)';
      rrect(g, r.x, r.y, r.w, r.h, 3); g.fill();
      strokeInside(g, r, 2, 'rgb(118,126,130)', 3);
      text(g, String(c[2]), r.x + 4, r.y + 3 + 7, 20, 'rgb(235,239,241)', 'left');
    }
  }
  drawEditorHud() {
    const g = this.g, n = this.editorLayer;
    const count = (this.layoutData || []).length;
    const odd = count % 2 ? '   (odd - one tile will be dropped)' : '';
    if (this.editBtns) {
      this.editBtns.mode.text = this.editRemove ? 'MODE: REMOVE' : 'MODE: ADD';
      this.editBtns.half.text = this.halfStep ? 'HALF-STEP: ON' : 'HALF-STEP: OFF';
    }
    if (this.WIDTH >= 1250 && !this.touch) {
      text(g, `Editing layer ${n}   (wheel/UP/DOWN = layer, left-click = add, SHIFT = half-step, right-click = remove)`, 160, 36 + 10, 28, 'rgb(255,215,60)', 'left');
      text(g, `${count} tiles placed${odd}`, 30, 82 + 10, 28, 'rgb(200,206,204)', 'left');
    } else {
      const hint = this.touch
        ? `Editing layer ${n}   (tap = ${this.editRemove ? 'remove' : 'add'}, two fingers = zoom and move)`
        : `Editing layer ${n}   (wheel/UP/DOWN = layer, left-click = add, SHIFT = half-step, right-click = remove)`;
      const sz = this.WIDTH < 900 ? 19 : 24;
      text(g, hint, 30, 92, sz, 'rgb(255,215,60)', 'left');
      text(g, `${count} tiles placed${odd}`, 30, 114, sz, 'rgb(200,206,204)', 'left');
    }
  }
  drawTilesetEditor() {
    const g = this.g;
    if (this.assignBtn) this.assignBtn.text = `ASSIGN TO ${this.selValue}`;
    const pal = this.paletteBoxes();
    text(g, 'LETTERS', 30, pal.labL + 8, 24, 'rgb(200,207,203)', 'left');
    text(g, 'DIGITS', 30, pal.labD + 8, 24, 'rgb(200,207,203)', 'left');
    for (const [r, kind, val] of pal.boxes) {
      const selected = this.selKind === kind && val === this.selValue;
      const assigned = !!this.customTs[kind][val];
      g.fillStyle = selected ? 'rgb(255,209,51)' : (assigned ? 'rgb(46,140,71)' : 'rgb(72,78,82)');
      rrect(g, r.x, r.y, r.w, r.h, 4); g.fill();
      strokeInside(g, r, 1, 'rgb(130,138,141)', 4);
      text(g, val, r.x + r.w / 2, r.y + r.h / 2, 24, selected ? 'rgb(30,33,34)' : 'rgb(232,237,234)', 'center');
    }
    text(g, `Selected: ${this.selKind} ${this.selValue}`, 30, pal.prevY - 24 + 8, 24, 'rgb(255,215,60)', 'left');
    const custom = this.customTs[this.selKind][this.selValue];
    if (custom && custom.surface) g.drawImage(custom.surface, 30, pal.prevY);

    const e = this.cur();
    let status;
    if (e) status = `Image ${this.imageIndex + 1} of ${this.images.length}: ${e.name}   rotation ${e.rotation} deg   (${e.crop ? 'crop set' : 'no crop - whole image'})`;
    else status = `No images loaded - click ADD IMAGES (up to ${MAX_IMAGES} at once)`;
    text(g, status, 420, 138 + 8, 24, 'rgb(220,226,222)', 'left');

    for (const [r, idx] of this.thumbRects()) {
      g.fillStyle = 'rgb(50,58,62)'; rrect(g, r.x, r.y, r.w, r.h, 3); g.fill();
      const th = this.images[idx].thumb(r.w - 4);
      g.drawImage(th, r.x + (r.w - th.width) / 2, r.y + (r.h - th.height) / 2);
      if (idx === this.imageIndex) strokeInside(g, r, 3, 'rgb(255,215,60)', 3);
      else strokeInside(g, r, 1, 'rgb(120,128,131)', 3);
    }

    const v = this.tilesetView();
    if (v) {
      g.drawImage(e.surface(), v.dx, v.dy, v.dw, v.dh);
      g.strokeStyle = 'rgb(255,215,60)'; g.lineWidth = 3;
      if (this.dragStart && this.dragNow) {
        const [x0, y0] = this.dragStart, [x1, y1] = this.dragNow;
        g.strokeRect(Math.min(x0, x1) + 1.5, Math.min(y0, y1) + 1.5, Math.max(0, Math.abs(x1 - x0) - 3), Math.max(0, Math.abs(y1 - y0) - 3));
      } else if (e.crop) {
        const [cx, cy, cw, ch] = e.crop;
        g.strokeRect(Math.trunc(v.dx + cx * v.f) + 1.5, Math.trunc(v.dy + cy * v.f) + 1.5,
          Math.max(0, Math.trunc(cw * v.f) - 3), Math.max(0, Math.trunc(ch * v.f) - 3));
      }
    } else {
      text(g, 'Click ADD IMAGES, then use < > to browse and drag a crop box.', 420, 240 + 10, 30, 'rgb(190,198,195)', 'left');
    }
    text(g, '1) ADD IMAGES   2) < > to browse   3) [ ] or ROTATE   4) drag a box to crop (optional)   5) click a letter/digit   6) ASSIGN   7) SAVE',
      30, this.HEIGHT - 70 + 8, 24, 'rgb(170,182,174)', 'left');
  }
  drawMusic() {
    const g = this.g, p = this.music.p, geo = this.musicGeometry();
    const { cx, x0, oy } = geo;
    const white = 'rgb(207,212,222)', soft = 'rgb(170,176,192)', dim = 'rgb(138,144,164)';
    text(g, 'MUSIC', cx, 36 + oy, 56, '#fff', 'center', true);
    text(g, 'Ambient and zen: random notes on the black keys only. It changes as you adjust it.', cx, 66 + oy + 8, 22, dim, 'center');

    if (this.musicToggleBtn) {
      this.musicToggleBtn.text = 'Music: ' + (p.on ? 'ON' : 'OFF');
      this.musicToggleBtn.fill = p.on ? [45, 106, 58] : [42, 48, 66];
    }
    text(g, '(M turns it on or off at any time)', x0 + 156, geo.toggleY + 15, 22, soft, 'left');
    text(g, 'Instrument', x0, geo.instY + 15, 24, white, 'left');
    for (const [b, nm] of this.musicInstBtns) {
      const chosen = p.inst === nm;
      b.fill = chosen ? [59, 53, 96] : [42, 48, 66];
      if (chosen) strokeInside(g, { x: b.rect.x - 2, y: b.rect.y - 2, w: b.rect.w + 4, h: b.rect.h + 4 }, 3, 'rgb(255,213,79)', 9);
    }

    for (const [row, y] of geo.rows) {
      if (row === null) {
        text(g, 'EFFECTS', x0, y + 8, 20, 'rgb(165,173,194)', 'left');
        g.strokeStyle = 'rgb(50,56,73)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x0 + 64, y + 8.5); g.lineTo(x0 + 660, y + 8.5); g.stroke();
        continue;
      }
      const [label, key, fmt] = row;
      const [lo, hi] = MUSIC.MUS_LIMITS[key];
      const v = p[key];
      text(g, label, x0, y + 12, 24, white, 'left');
      const bx = x0 + 226, by = y + 6;
      g.fillStyle = 'rgb(23,26,36)'; g.fillRect(bx, by, 200, 12);
      g.fillStyle = 'rgb(108,140,255)'; g.fillRect(bx, by, Math.trunc(200 * (v - lo) / Math.max(1, hi - lo)), 12);
      g.strokeStyle = 'rgb(58,65,86)'; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, 199, 11);
      text(g, fmt(v, p), x0 + 474, y + 12, 24, '#fff', 'left', true);
    }
    this.musicScreenNotes().forEach((line, i) => text(g, line, cx, geo.endY + 52 + i * 26, 24, 'rgb(255,184,107)', 'center'));
  }
  noteY() {
    return this.HEIGHT - (this.mode === 'game' && !this.gameBig() ? 20 : 25);
  }
  drawNotification() {
    const g = this.g;
    const elapsed = this.now() - this.notificationTime;
    const alpha = Math.max(0, 1 - elapsed / NOTE_MS);
    g.font = `${Math.round(34 * FONT_K)}px ${FPS_FONT}`;
    const tw = g.measureText(this.notification).width;
    const w = tw + 28, h = Math.round(34 * FONT_K * 1.15) + 14;
    const cx = this.WIDTH / 2, cy = this.noteY();
    g.fillStyle = `rgba(0,0,0,${Math.min(alpha, 0.745)})`;
    g.fillRect(cx - w / 2, cy - h / 2, w, h);
    text(g, this.notification, cx, cy, 34, 'rgb(255,221,97)', 'center');
  }
}

/* ---------------------------------------------------------------- start (called from main.js) */
function startMahjong() {
  const canvas = document.getElementById('c');
  const game = new Game(canvas);
  window.mahjong = game;
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); game.onPointerDown(e); });
  window.addEventListener('pointermove', (e) => game.onPointerMove(e));
  window.addEventListener('pointerup', (e) => game.onPointerUp(e));
  window.addEventListener('pointercancel', (e) => game.onPointerUp(e));
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); game.onWheel(e); }, { passive: false });
  window.addEventListener('keydown', (e) => { if (game.onKey(e)) e.preventDefault(); });
  window.addEventListener('resize', () => game.resize());
  document.addEventListener('visibilitychange', () => { game.mx = game.my = -1; });
  const loop = () => { game.frame(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
