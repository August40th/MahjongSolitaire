'use strict';
/* =====================================================================================================
   Mahjong Solitaire - game logic (no drawing, no DOM): layout, free-tile rules, solvable deals, FIND,
   matches counter, quadruples, undo, shuffle. A direct port of the Python version.
   ===================================================================================================== */

const TILE_W = 72;
const TILE_H = 96;
const LAYER_DX = 16;
const LAYER_DY = 18;
const TILE_DEPTH = 12;    // thickness of a tile in the game view (each layer is raised by this much)
const TILE_INSET = 4;
const MAX_IMAGES = 18;

const BG_DEFAULT = 'rgb(255,255,255)';
const BG_SELECTED = 'rgb(255,213,0)';
const BG_MISMATCH = 'rgb(255,56,56)';
const BG_MATCHING = 'rgb(46,214,71)';

const BORDER_DEFAULT = 'rgb(150,140,120)';
const BORDER_SELECTED = 'rgb(176,122,0)';
const BORDER_MISMATCH = 'rgb(170,0,0)';
const BORDER_MATCHING = 'rgb(0,128,20)';

const FLASH_MISMATCH_MS = 750;
const FLASH_MATCH_MS = 320;

const TILE_TYPES = {
  letter: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  digit: '0123456789'.split(''),
};
const KINDS = ['letter', 'digit'];

const COLORS = {
  red: [190, 40, 40],
  green: [40, 130, 55],
  blue: [30, 90, 190],
  black: [50, 50, 50],
};
const COLOR_ORDER = ['red', 'green', 'blue', 'black'];

const EDITOR_COLS = [0, 16];   // editor grid bounds (x)
const EDITOR_ROWS = [0, 9];    // editor grid bounds (y)
const EDITOR_MAX_LAYER = 4;

function buildExactLayout() {
  const cells = [];
  const rows = { 1: [2, 13], 2: [4, 11], 3: [3, 12], 4: [2, 13], 5: [2, 13], 6: [3, 12], 7: [4, 11], 8: [2, 13] };
  for (const row of Object.keys(rows)) {
    const [c0, c1] = rows[row];
    for (let c = c0; c <= c1; c++) cells.push([c, Number(row), 0]);
  }
  for (const c of [1, 14, 15]) cells.push([c, 4.5, 0]);
  for (let r = 2; r <= 7; r++) for (let c = 5; c <= 10; c++) cells.push([c, r, 1]);
  for (let r = 3; r <= 6; r++) for (let c = 6; c <= 9; c++) cells.push([c, r, 2]);
  for (let r = 4; r <= 5; r++) for (let c = 7; c <= 8; c++) cells.push([c, r, 3]);
  cells.push([7.5, 4.5, 4]);
  if (cells.length !== 144) throw new Error('layout must have 144 tiles');
  return cells;
}
const LAYOUTS = { 'Exact Turtle': buildExactLayout };

/* ------------------------------------------------------------------ tile */
class Tile {
  constructor(gx, gy, z, kind, value, color) {
    this.gx = +gx;
    this.gy = +gy;
    this.z = z | 0;
    this.kind = kind;
    this.value = value;
    this.color = color;
    this.visible = true;
    this.selected = false;
    this.free = false;
    this.removing = false;          // true during the green "matched" flash
    this.customSurface = null;
    this.bg = BG_DEFAULT;
    this.border = BORDER_DEFAULT;
    this.borderWidth = 2;
  }
  setState(bg, border, width) { this.bg = bg; this.border = border; this.borderWidth = width; }
  clearState() { this.setState(BG_DEFAULT, BORDER_DEFAULT, 2); }
}

/* ------------------------------------------------------------------ game core */
class GameCore {
  constructor(opts = {}) {
    this.now = opts.now || (() => performance.now());
    this.rand = opts.rand || Math.random;
    this.WIDTH = opts.width || 1280;
    this.HEIGHT = opts.height || 720;

    this.layoutName = 'Exact Turtle';
    this.layerDx = LAYER_DX;        // how far each layer is shifted (the game screen sets 0: tiles stack straight up)
    this.layerDy = LAYER_DY;
    this.tileInset = TILE_INSET;    // gap between neighbouring tiles (the game screen sets 0: tiles sit flush)
    this.tiles = [];
    this.selected = null;
    this.won = false;

    this.customTs = { letter: {}, digit: {} };      // kind -> value -> { surface }

    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.originGx = 0;
    this.originGy = 0;
    this.boardW = 0;
    this.boardH = 0;

    this.layoutData = null;
    this.layoutEdited = false;

    this.matchHistory = [];
    this.highlightPair = [];
    this.findIndex = 0;
    this.findAnchor = null;         // tile FIND is pairing others with
    this.findLastAnchor = null;
    this.quadValues = new Set();    // "kind|value" with all four tiles free
    this.pending = [];
    this.locked = false;

    this.notification = null;
    this.notificationTime = 0;
  }

  /* ---------------------------------------------------------- helpers */
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  notify(message) {
    this.notification = message;
    this.notificationTime = this.now();
  }

  /* ---------------------------------------------------------- dealing */
  getCells() {
    const raw = (this.layoutEdited && this.layoutData && this.layoutData.length)
      ? this.layoutData : LAYOUTS[this.layoutName]();
    return raw.map(c => [+c[0], +c[1], c[2] | 0]);
  }

  makePairs(n) {
    const base = [];
    for (const kind of KINDS) {
      for (const v of TILE_TYPES[kind]) {
        base.push([[kind, v, 'red'], [kind, v, 'green']]);
        base.push([[kind, v, 'blue'], [kind, v, 'black']]);
      }
    }
    let pairs = [];
    while (pairs.length < n) pairs = pairs.concat(this.shuffle(base.slice()));
    return pairs.slice(0, n);
  }

  /* Give the tiles faces so the board is guaranteed solvable: simulate removing free tiles two at a time,
     and give each removed pair one matching pair of faces. Replaying that order clears the board. */
  dealSolvable(tiles, pairs, attempts = 300) {
    for (let a = 0; a < attempts; a++) {
      for (const t of tiles) t.visible = true;
      const order = [];
      let ok = true;
      for (let p = 0; p < pairs.length; p++) {
        this.updateFree();
        const free = tiles.filter(t => t.visible && t.free);
        if (free.length < 2) { ok = false; break; }
        const i = Math.floor(this.rand() * free.length);
        let j = Math.floor(this.rand() * (free.length - 1));
        if (j >= i) j++;
        free[i].visible = false;
        free[j].visible = false;
        order.push([free[i], free[j]]);
      }
      if (ok) {
        for (let k = 0; k < order.length; k++) {
          const [x, y] = order[k];
          const [fa, fb] = pairs[k];
          x.kind = fa[0]; x.value = fa[1]; x.color = fa[2];
          y.kind = fb[0]; y.value = fb[1]; y.color = fb[2];
        }
        for (const t of tiles) t.visible = true;
        return true;
      }
    }
    for (const t of tiles) t.visible = true;
    return false;
  }

  resetFindState() {
    this.findIndex = 0;
    this.findAnchor = null;
    this.findLastAnchor = null;
  }

  applyFace(tile) {
    const c = (this.customTs[tile.kind] || {})[tile.value];
    tile.customSurface = c && c.surface ? c.surface : null;
  }

  newDeal() {
    this.won = false;
    this.selected = null;
    this.matchHistory = [];
    this.highlightPair = [];
    this.resetFindState();
    this.pending = [];
    this.locked = false;
    this.quadValues = new Set();

    let cells = this.getCells();
    if (cells.length % 2) {
      cells = cells.slice(0, -1);
      this.notify('Layout had an odd tile count - one tile dropped');
    }
    if (cells.length < 2) {
      this.tiles = [];
      this.notify('Layout has too few tiles');
      return;
    }

    this.tiles = cells.map(([gx, gy, z]) => new Tile(gx, gy, z, 'letter', 'A', 'red'));
    const pairs = this.makePairs(cells.length / 2);

    if (!this.dealSolvable(this.tiles, pairs)) {
      const faces = [].concat(...pairs.map(p => [p[0], p[1]]));
      this.shuffle(faces);
      this.tiles.forEach((t, i) => { [t.kind, t.value, t.color] = faces[i]; });
      this.notify('Could not guarantee a solvable deal - dealt randomly');
    }

    for (const t of this.tiles) {
      t.visible = true;
      t.clearState();
      this.applyFace(t);
    }

    this.recalculateView();
    this.updateFree();
    this.refreshQuads();
  }

  /* ---------------------------------------------------------- geometry */
  setView(minGx, maxGx, minGy, maxGy, maxZ) {
    const boardW = (maxGx - minGx + 1) * TILE_W + maxZ * this.layerDx;
    const boardH = (maxGy - minGy + 1) * TILE_H + maxZ * this.layerDy;
    const topMargin = this.topMargin !== undefined ? this.topMargin : 115;
    const bottomMargin = this.bottomMargin !== undefined ? this.bottomMargin : 135;
    const leftMargin = this.leftMargin !== undefined ? this.leftMargin : 50;
    const rightMargin = this.rightMargin !== undefined ? this.rightMargin : 50;
    const availW = this.WIDTH - leftMargin - rightMargin;
    const availH = this.HEIGHT - topMargin - bottomMargin;
    this.scale = Math.min(1.0, availW / boardW, availH / boardH);
    this.boardW = boardW * this.scale;
    this.boardH = boardH * this.scale;
    this.originGx = minGx;
    this.originGy = minGy;
    this.offsetX = leftMargin + (availW - this.boardW) / 2;
    this.offsetY = topMargin + (availH - this.boardH) / 2;
  }

  recalculateView() {
    let cells = this.tiles.map(t => [t.gx, t.gy, t.z]);
    if (!cells.length) cells = this.getCells();
    if (!cells.length) return;
    this.setView(Math.min(...cells.map(c => c[0])), Math.max(...cells.map(c => c[0])),
                 Math.min(...cells.map(c => c[1])), Math.max(...cells.map(c => c[1])),
                 Math.max(...cells.map(c => c[2])));
  }

  cellRect(gx, gy, z) {
    const s = this.scale;
    const x = this.offsetX + (gx - this.originGx) * TILE_W * s + z * this.layerDx * s;
    const y = this.offsetY + (gy - this.originGy) * TILE_H * s - z * this.layerDy * s;
    return { x: Math.trunc(x), y: Math.trunc(y),
             w: Math.trunc((TILE_W - this.tileInset) * s), h: Math.trunc((TILE_H - this.tileInset) * s) };
  }

  tileRect(t) { return this.cellRect(t.gx, t.gy, t.z); }

  tileAt(px, py) {
    const order = this.tiles.slice().sort((a, b) => (b.z - a.z) || (b.gy - a.gy) || (b.gx - a.gx));
    for (const t of order) {
      if (!t.visible) continue;
      const r = this.tileRect(t);
      if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return t;
    }
    return null;
  }

  /* ---------------------------------------------------------- rules */
  /* A tile is free if nothing sits on top of it AND it is not blocked on both its left and right.
     Positions are compared in half-cell units so the half-row side tiles (the turtle's "ears") block
     correctly. */
  updateFree() {
    const key = (z, kx, ky) => ((z + 8) * 1024 + (kx + 512)) * 1024 + (ky + 512);
    const occ = new Set();
    let maxZ = 0;
    for (const t of this.tiles) {
      if (t.visible) {
        occ.add(key(t.z, Math.round(t.gx * 2), Math.round(t.gy * 2)));
        if (t.z > maxZ) maxZ = t.z;
      }
    }
    for (const t of this.tiles) {
      if (!t.visible) { t.free = false; continue; }
      const kx = Math.round(t.gx * 2);
      const ky = Math.round(t.gy * 2);
      let covered = false;
      for (let z = t.z + 1; z <= maxZ && !covered; z++) {
        for (let dx = -1; dx <= 1 && !covered; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (occ.has(key(z, kx + dx, ky + dy))) { covered = true; break; }
          }
        }
      }
      if (covered) { t.free = false; continue; }
      let left = false, right = false;
      for (let dy = -1; dy <= 1; dy++) {
        if (occ.has(key(t.z, kx - 2, ky + dy))) left = true;
        if (occ.has(key(t.z, kx + 2, ky + dy))) right = true;
      }
      t.free = !(left && right);
    }
  }

  canMatch(a, b) {
    if (a === b) return false;
    return a.kind === b.kind && a.value === b.value;
  }

  freeTiles() { return this.tiles.filter(t => t.visible && t.free); }

  allPairs() {
    const free = this.freeTiles();
    const out = [];
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        if (this.canMatch(free[i], free[j])) out.push([free[i], free[j]]);
      }
    }
    return out;
  }

  findPair() {
    const free = this.freeTiles();
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        if (this.canMatch(free[i], free[j])) return [free[i], free[j]];
      }
    }
    return null;
  }

  /* Number of distinct matching pairs among the free tiles right now - exactly the number of presses FIND
     needs to cycle through every match and come back to the first one (4 free copies = 6 pairs).
     Tiles already matched and mid-flash ("removing") are not counted. */
  countMoves() {
    const groups = new Map();
    for (const t of this.tiles) {
      if (t.visible && t.free && !t.removing) {
        const k = t.kind + '|' + t.value;
        groups.set(k, (groups.get(k) || 0) + 1);
      }
    }
    let total = 0;
    for (const n of groups.values()) total += n * (n - 1) / 2;
    return total;
  }

  /* Face values whose four tiles are ALL free right now. */
  quadSet() {
    const groups = new Map();
    for (const t of this.tiles) {
      if (t.visible && t.free && !t.removing) {
        const k = t.kind + '|' + t.value;
        groups.set(k, (groups.get(k) || 0) + 1);
      }
    }
    const out = new Set();
    for (const [k, n] of groups) if (n >= 4) out.add(k);
    return out;
  }

  refreshQuads() { this.quadValues = this.quadSet(); }

  /* ---------------------------------------------------------- scheduling */
  schedule(delayMs, fn) { this.pending.push([this.now() + delayMs, fn]); }

  processPending() {
    if (!this.pending.length) return;
    const now = this.now();
    const due = this.pending.filter(it => it[0] <= now);
    this.pending = this.pending.filter(it => it[0] > now);
    for (const it of due) it[1]();
  }

  /* ---------------------------------------------------------- actions */
  clearSelection() {
    if (this.selected) {
      this.selected.selected = false;
      this.selected.clearState();
      this.selected = null;
    }
  }

  clearHighlight() {
    for (const t of this.highlightPair) { t.selected = false; t.clearState(); }
    this.highlightPair = [];
  }

  /* FIND with a tile selected: highlight that tile plus a free match for it (press again to cycle through
     its other free matches). FIND with nothing selected: highlight a matching pair (press again for the
     next one). Click a highlighted tile to remove the pair. */
  findMove() {
    if (this.locked || !this.canPlay()) return;

    let anchor = this.selected;
    const fromSelection = anchor !== null;
    if (anchor === null && this.findAnchor !== null && this.highlightPair.includes(this.findAnchor)) {
      anchor = this.findAnchor;           // keep cycling around the same tile
    }

    this.clearHighlight();                // old yellow tiles go back to white
    if (fromSelection) {
      anchor.selected = false;
      anchor.clearState();
      this.selected = null;
    }

    let pair, message;
    if (anchor !== null) {
      const partners = this.freeTiles().filter(t => this.canMatch(anchor, t));
      if (!partners.length) {
        // Nothing to pair with: the tile is deselected and flashes red, then goes back to plain white.
        this.findAnchor = null;
        anchor.selected = false;
        anchor.setState(BG_MISMATCH, BORDER_MISMATCH, 4);
        const restore = () => {
          if (anchor.visible && anchor.bg === BG_MISMATCH && anchor !== this.selected) anchor.clearState();
        };
        this.schedule(FLASH_MISMATCH_MS, restore);
        this.notify('No free match for ' + anchor.value + ' right now');
        return;
      }
      if (anchor !== this.findLastAnchor) this.findIndex = 0;
      this.findLastAnchor = anchor;
      this.findAnchor = anchor;
      const pos = this.findIndex % partners.length;
      pair = [anchor, partners[pos]];
      message = 'Match for ' + anchor.value + ' highlighted (option ' + (pos + 1) + ' of ' +
                partners.length + ') - click to remove';
    } else {
      const pairs = this.allPairs();
      if (!pairs.length) { this.notify('No moves left - try SHUFFLE'); return; }
      if (this.findLastAnchor !== null) this.findIndex = 0;
      this.findLastAnchor = null;
      this.findAnchor = null;
      pair = pairs[this.findIndex % pairs.length];
      message = 'Match highlighted - click one of them to remove';
    }

    this.findIndex += 1;
    for (const t of pair) { t.selected = true; t.setState(BG_SELECTED, BORDER_SELECTED, 4); }
    this.highlightPair = pair.slice();
    this.notify(message);
  }

  undoMove() {
    if (this.locked || !this.canPlay()) return;
    if (!this.matchHistory.length) { this.notify('Nothing to undo'); return; }
    this.clearSelection();
    this.clearHighlight();
    for (const t of this.matchHistory.pop()) {
      t.visible = true;
      t.selected = false;
      t.removing = false;
      t.clearState();
    }
    this.won = false;
    this.resetFindState();
    this.updateFree();
    this.refreshQuads();
    this.notify('Undone');
  }

  reshuffle() {
    if (this.locked || !this.canPlay()) return;
    this.clearSelection();
    this.clearHighlight();

    const visible = this.tiles.filter(t => t.visible);
    if (visible.length < 2) { this.notify('Not enough tiles to shuffle'); return; }

    // Rebuild matching pairs from the faces still on the board.
    const groups = new Map();
    for (const t of visible) {
      const k = t.kind + '|' + t.value;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push([t.kind, t.value, t.color]);
    }
    const pairs = [];
    const leftovers = [];
    for (const faces of groups.values()) {
      this.shuffle(faces);
      while (faces.length >= 2) pairs.push([faces.pop(), faces.pop()]);
      leftovers.push(...faces);
    }

    let done = false;
    if (!leftovers.length) done = this.dealSolvable(visible, pairs, 200);

    if (!done) {
      const faces = visible.map(t => [t.kind, t.value, t.color]);
      for (let i = 0; i < 200; i++) {
        this.shuffle(faces);
        visible.forEach((t, j) => { [t.kind, t.value, t.color] = faces[j]; });
        this.updateFree();
        if (this.findPair() !== null) { done = true; break; }
      }
    }

    for (const t of visible) { t.visible = true; this.applyFace(t); }

    this.resetFindState();
    this.updateFree();
    this.refreshQuads();
    this.notify(done ? 'Shuffled' : 'Shuffled - no matching moves possible');
  }

  finishMatch(t1, t2) {
    this.matchHistory.push([t1, t2]);
    for (const t of [t1, t2]) {
      t.visible = false;
      t.selected = false;
      t.removing = false;
      t.clearState();
    }
    this.locked = false;
    this.resetFindState();

    this.updateFree();
    this.refreshQuads();

    if (!this.tiles.some(t => t.visible)) {
      this.won = true;
      this.notify('Board cleared!');
    } else if (this.findPair() === null) {
      this.notify('No moves left - use UNDO or SHUFFLE');
    }
  }

  flashMismatch(t1, t2) {
    for (const t of [t1, t2]) {
      t.selected = false;
      t.setState(BG_MISMATCH, BORDER_MISMATCH, 4);
    }
    this.locked = true;
    this.schedule(FLASH_MISMATCH_MS, () => {
      for (const t of [t1, t2]) t.clearState();
      this.locked = false;
    });
  }

  /* ---------------------------------------------------------- clicking */
  clickTile(tile) {
    if (this.locked) return;

    // Clicking a FIND-highlighted tile removes the highlighted pair.
    if (this.highlightPair.includes(tile)) {
      const other = this.highlightPair[0] === tile ? this.highlightPair[1] : this.highlightPair[0];
      this.clearHighlight();
      this.finishMatch(tile, other);
      return;
    }

    // Clicking anything else clears the highlight (tiles go white).
    if (this.highlightPair.length) this.clearHighlight();

    if (!tile.free) { this.notify('That tile is blocked.'); return; }

    if (this.selected === tile) {
      tile.selected = false;
      tile.clearState();
      this.selected = null;
      return;
    }

    if (this.selected === null) {
      tile.selected = true;
      tile.setState(BG_SELECTED, BORDER_SELECTED, 4);
      this.selected = tile;
      return;
    }

    const first = this.selected;
    if (this.canMatch(first, tile)) {
      first.selected = false;
      first.removing = true;
      tile.removing = true;
      first.setState(BG_MATCHING, BORDER_MATCHING, 4);
      tile.setState(BG_MATCHING, BORDER_MATCHING, 4);
      this.selected = null;
      this.locked = true;
      this.schedule(FLASH_MATCH_MS, () => this.finishMatch(first, tile));
    } else {
      this.selected = null;
      this.flashMismatch(first, tile);
    }
  }

  /* One copy of each tile whose pair (2 of its 4) has been cleared; gone again once all four are cleared.
     Letters A-Z first, then digits 0-9. */
  trayTiles() {
    const by = new Map();
    for (const t of this.tiles) {
      if (t.visible) continue;
      const k = t.kind + '|' + t.value, e = by.get(k);
      if (e) e.n++; else by.set(k, { n: 1, tile: t });
    }
    const out = [];
    for (const kind of KINDS) for (const v of TILE_TYPES[kind]) {
      const e = by.get(kind + '|' + v);
      if (e && e.n === 2) out.push(e.tile);
    }
    return out;
  }

  /* The UI overrides this: game actions only work on the game screen. */
  canPlay() { return true; }
}

if (typeof module !== 'undefined') {
  module.exports = { GameCore, Tile, buildExactLayout, LAYOUTS, TILE_TYPES, KINDS, COLORS, COLOR_ORDER,
                     BG_DEFAULT, BG_SELECTED, BG_MISMATCH, BG_MATCHING, FLASH_MATCH_MS, FLASH_MISMATCH_MS,
                     TILE_W, TILE_H, TILE_INSET, EDITOR_COLS, EDITOR_ROWS, EDITOR_MAX_LAYER, MAX_IMAGES };
}
