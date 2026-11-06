#!/usr/bin/env python3
"""
Mahjong Solitaire - Exact Turtle Layout with Alphanumeric Tiles

Controls (game):   F = find a match (press again to cycle). If a tile is
                   selected, F highlights that tile together with a free
                   match for it. Click a highlighted tile to remove the pair.
                   U = undo, S = shuffle, N = new deal, Esc = back to menu.
                   The side panel's "Quadruples" counts values whose four
                   copies are all free at the same time.
                   M (or the MUSIC button in the game) = music on/off. The music
                   is the ambient piano music from Rainbow Runner; MUSIC on the
                   title screen opens its settings (saved next to this script).
Controls (editor): left-click = add tile on current layer (hold SHIFT for
                   half-grid steps), right-click = remove tile,
                   mouse wheel or UP/DOWN = change layer
Tileset editor:    ADD IMAGES (pick up to 18 at once), LEFT/RIGHT arrows or
                   the < > buttons browse them, [ and ] (or the ROTATE
                   buttons) rotate the current image, drag a box to crop
                   (optional), click a letter/digit, press ASSIGN, then SAVE.
"""

import array
import atexit
import json
import math
import os
import random
import sys
import threading
import time
import traceback

if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import pygame
from pygame.locals import *

pygame.init()

# ------------------------------------------------------------------ constants
FPS = 60

TILE_W = 72
TILE_H = 96
LAYER_DX = 16
LAYER_DY = 18
TILE_INSET = 4

MAX_IMAGES = 18

# ---------------------------------------------------------------- colours
BG_DEFAULT  = (255, 255, 255)
BG_SELECTED = (255, 213,   0)
BG_MISMATCH = (255,  56,  56)
BG_MATCHING = ( 46, 214,  71)

BORDER_DEFAULT  = (150, 140, 120)
BORDER_SELECTED = (176, 122,   0)
BORDER_MISMATCH = (170,   0,   0)
BORDER_MATCHING = (  0, 128,  20)

FLASH_MISMATCH_MS = 750
FLASH_MATCH_MS    = 320

# ---------------------------------------------------------------- fonts
_FONTS = {}


def font(size):
    """Cached font so we do not rebuild Font objects every frame."""
    f = _FONTS.get(size)
    if f is None:
        f = pygame.font.Font(None, size)
        _FONTS[size] = f
    return f


def _bold_font(size):
    f = _FONTS.get(("bold", size))
    if f is None:
        f = pygame.font.Font(None, size)
        f.set_bold(True)
        _FONTS[("bold", size)] = f
    return f


# ====================================================================================================
# AMBIENT MUSIC: a never-ending, randomly composed sequence on the five black keys of a piano.
# Everything is synthesised here (no sound files, no extra packages). Windows plays it through
# winmm (ctypes); other systems just stay silent. Needs Python's 'audioop' module: it is in the
# standard library up to Python 3.12; on Python 3.13+ run:  py -m pip install audioop-lts
# (This block is copied unchanged from Rainbow Runner.)
# ====================================================================================================
try:
    import audioop as _ao                        # in the standard library up to Python 3.12
except Exception:                                # pragma: no cover
    _ao = None

MUS_RATE = 22050                                 # samples per second (stereo, 16 bit)
MUS_N = 512                                      # frames per processing block (23 ms)
MUS_BUF = 4                                      # blocks per device buffer
MUS_NBUF = 6                                     # device buffers kept queued
MUS_INSTRUMENTS = ("Piano", "Koto", "Steel drum", "Kalimba")
MUS_DEFAULTS = dict(on=True, inst="Piano", oct_lo=2, oct_n=4, density=10, long=3, voices=4, vol=7,
                    rev_mix=8, rev_len=8, dly_mix=4, dly_time=7, pha_mix=9, pha_rate=8,
                    fla_mix=10, fla_rate=8)
MUS_LIMITS = dict(oct_lo=(1, 6), oct_n=(1, 4), density=(1, 15), long=(0, 10), voices=(1, 4), vol=(0, 10),
                  rev_mix=(0, 10), rev_len=(1, 10), dly_mix=(0, 10), dly_time=(1, 10), pha_mix=(0, 10),
                  pha_rate=(1, 10), fla_mix=(0, 10), fla_rate=(1, 10))
BLACK_PCS = (1, 3, 6, 8, 10)                     # C#  D#  F#  G#  A#
NOTE_NAMES = {1: "C#", 3: "D#", 6: "F#", 8: "G#", 10: "A#"}


def music_clean(d):
    """A complete, valid settings dict from whatever was saved."""
    out = dict(MUS_DEFAULTS)
    if isinstance(d, dict):
        for k, v in d.items():
            if k == "on":
                out["on"] = bool(v)
            elif k == "inst" and v in MUS_INSTRUMENTS:
                out["inst"] = v
            elif k in MUS_LIMITS and isinstance(v, (int, float)) and not isinstance(v, bool):
                lo, hi = MUS_LIMITS[k]
                out[k] = max(lo, min(hi, int(v)))
    out["oct_lo"] = min(out["oct_lo"], 7 - out["oct_n"])
    return out


def music_pitches(p):
    """Every black-key MIDI note inside the chosen octave range, low to high."""
    lo = p["oct_lo"]
    return [12 * (o + 1) + pc for o in range(lo, lo + p["oct_n"]) for pc in BLACK_PCS]


def music_note_name(m):
    return "%s%d" % (NOTE_NAMES.get(m % 12, "?"), m // 12 - 1)


def _grand_piano(buf, f, midi, ls):
    """A grand piano note, added into buf. What makes it a piano and not a keyboard: every partial is
    slightly stretched (stiff strings), every partial is TWO strings tuned a fraction of a cent apart (they
    beat and shimmer), the sound dies in two stages (a quick 'prompt' fall, then a long 'after-ring'),
    higher partials die sooner, the hammer strikes a point on the string (some partials are weak), and the
    felt hammer adds a soft thump at the start."""
    n = len(buf)
    rng = random.Random(midi * 7 + 1)
    sin, exp = math.sin, math.exp
    two_pi = 2.0 * math.pi
    big_b = 0.00012 * exp((midi - 48) / 16.0)                     # string stiffness: stretched partials
    tau1 = max(0.35, min(4.0, 1.7 * (261.6 / f) ** 0.55)) * ls    # low notes ring much longer
    for k in range(1, 19):
        fk = k * f * math.sqrt(1.0 + big_b * k * k)
        if fk > MUS_RATE * 0.45:
            break
        amp = abs(sin(math.pi * k * 0.12)) / k ** 0.75 * exp(-(k - 1) * 0.11)
        if amp < 0.004:
            continue
        t1 = tau1 / (1.0 + 0.35 * (k - 1) ** 1.1)
        t2 = t1 * 4.5
        m = min(n, int(MUS_RATE * t2 * 6.0))
        d1, d2 = exp(-1.0 / (MUS_RATE * t1)), exp(-1.0 / (MUS_RATE * t2))
        cents = rng.uniform(0.3, 0.9) / 1200.0 * math.log(2.0)
        wa = two_pi * fk * (1.0 + cents) / MUS_RATE
        wb = two_pi * fk * (1.0 - cents) / MUS_RATE
        pa, pb = rng.uniform(0, two_pi), rng.uniform(0, two_pi)
        e1, e2 = 0.6 * amp * 0.5, 0.4 * amp * 0.5
        for i in range(m):
            buf[i] += (e1 + e2) * (sin(wa * i + pa) + sin(wb * i + pb))
            e1 *= d1
            e2 *= d2
    lp = 0.0                                                      # the hammer's felt thump
    a = min(0.9, 2.0 * math.pi * min(2500.0, f * 3.0) / MUS_RATE)
    for i in range(int(0.06 * MUS_RATE)):
        lp += a * (rng.uniform(-1.0, 1.0) - lp)
        buf[i] += 0.55 * lp * exp(-i / (0.008 * MUS_RATE))


def _synth_note(inst, midi, long_):
    """One note of an instrument as a list of 16 bit samples (mono). Additive synthesis: a handful of
    partials, each with its own decay; `long_` stretches every decay so the note rings on."""
    f = 440.0 * 2.0 ** ((midi - 69) / 12.0)
    secs = 10.0 if long_ else 7.0
    n = int(MUS_RATE * secs)
    ls = 2.6 if long_ else 1.0
    tl = max(0.55, min(1.6, (261.6 / f) ** 0.35))        # low notes ring longer
    bend = 0.0
    if inst == "Piano":
        parts = []
    elif inst == "Koto":
        parts = [(float(k), 1.0 / k ** 0.8, 2.0 * tl / k ** 0.75) for k in range(1, 9)]
        parts.append((1.004, 0.25, 1.4 * tl))                # a faint second string: slight shimmer
        bend = 0.011
    elif inst == "Steel drum":
        parts = [(1.0, 1.0, 2.4 * tl), (1.003, 0.45, 2.1 * tl), (2.0, 0.75, 1.7 * tl), (3.0, 0.38, 1.0 * tl),
                 (4.01, 0.20, 0.6 * tl), (5.98, 0.08, 0.35 * tl), (2.76, 0.12, 0.18 * tl)]
    else:                                                    # Kalimba
        parts = [(1.0, 1.0, 2.6 * tl), (2.0, 0.16, 1.1 * tl), (5.4, 0.30, 0.24 * tl), (8.9, 0.09, 0.10 * tl)]
    buf = [0.0] * n
    two_pi = 2.0 * math.pi
    sin, exp = math.sin, math.exp
    if inst == "Piano":
        _grand_piano(buf, f, midi, ls)
    for ratio, amp, tau in parts:
        fr = f * ratio
        if fr > MUS_RATE * 0.45:
            continue
        tau *= ls
        m = min(n, int(MUS_RATE * tau * 7.0))
        dec = exp(-1.0 / (MUS_RATE * tau))
        w = two_pi * fr / MUS_RATE
        e = amp
        if bend:
            tb = 0.06 * MUS_RATE
            for i in range(m):
                buf[i] += e * sin(w * (i + bend * tb * (1.0 - exp(-i / tb))))
                e *= dec
        else:
            for i in range(m):
                buf[i] += e * sin(w * i)
                e *= dec
    for i in range(80):                                      # a soft attack: no click
        buf[i] *= i / 80.0
    peak = max(max(buf), -min(buf)) or 1.0
    k = 0.8 * 32767.0 / peak
    return array.array("h", [int(x * k) for x in buf]).tobytes()


class _SampleBank:
    """Notes are synthesised in a background thread, a few at a time, and then simply played back."""

    def __init__(self):
        self.cache = {}
        self.queue = []
        self.lock = threading.Lock()
        self.thread = None
        self.alive = True

    def want(self, keys, inst):
        with self.lock:
            for k in [k for k in self.cache if k[0] != inst]:       # forget the other instruments
                del self.cache[k]
            self.queue = [k for k in keys if k not in self.cache]
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._work, daemon=True)
            self.thread.start()

    def get(self, key):
        return self.cache.get(key)

    def _work(self):
        while self.alive:
            with self.lock:
                key = self.queue.pop(0) if self.queue else None
            if key is None:
                return
            try:
                data = _synth_note(*key)
            except Exception:
                continue
            with self.lock:
                self.cache[key] = data
            time.sleep(0.005)


class AmbientMusic:
    """The player: composes notes, mixes up to four voices and runs them through phaser, flanger, echo
    and reverb. `block()` makes 23 ms of stereo audio; a thread feeds the sound card with those."""

    COMB_L = (24.1, 29.7, 37.1, 41.1, 47.3, 53.9)             # reverb delay lines in ms (all >= one block)
    COMB_R = (25.3, 31.9, 35.3, 43.3, 49.9, 57.1)

    def __init__(self, settings=None, seed=None):
        self.p = music_clean(settings)
        self.rng = random.Random(seed)
        self.bank = _SampleBank()
        self.thread = None
        self.stop_ev = threading.Event()
        self.error = ""
        self.voices = []
        self.t = 0                                           # frames rendered so far
        self.next_on = int(0.6 * MUS_RATE)
        self.recent = []                                     # the last pitches played
        self.tri = []                                        # recent three-note shapes
        self.ivs = []                                        # recent intervals
        self.reg = {}                                        # how often each octave was used lately
        self.sig = None
        self.silence = bytes(MUS_N * 4)
        # effect state
        self.pha_ph = 0.0
        self.pha_st = [[0.0] * 8, [0.0] * 8]
        self.fla_ph = 0.0
        self.dry_hist = bytes(2 * 4 * 400)
        self.echo = [bytes(0), bytes(0)]                     # mono echo history
        self.combs = [[bytes(2 * 4096) for _ in self.COMB_L], [bytes(2 * 4096) for _ in self.COMB_R]]
        self.comb_last = [[0] * len(self.COMB_L), [0] * len(self.COMB_R)]
        self.fade = 0.0

    # ----- control -----
    @property
    def available(self):
        return _ao is not None

    def set(self, **kw):
        q = dict(self.p)
        q.update(kw)
        self.p = music_clean(q)
        if self.running():
            self._sync_bank()

    def _sync_bank(self):
        sig = (self.p["inst"], self.p["oct_lo"], self.p["oct_n"], self.p["long"] > 0)
        if sig == self.sig:
            return
        self.sig = sig
        pits = music_pitches(self.p)
        order = pits[:]
        self.rng.shuffle(order)
        keys = [(self.p["inst"], m, False) for m in order]
        if self.p["long"] > 0:
            keys += [(self.p["inst"], m, True) for m in order]
        self.bank.want(keys, self.p["inst"])

    def start(self):
        if not self.available or sys.platform != "win32":
            return False
        if self.thread is not None and self.thread.is_alive():
            return True
        self.stop_ev.clear()
        self.error = ""
        self.fade = 0.0
        self.sig = None
        self._sync_bank()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        return True

    def stop(self):
        self.stop_ev.set()
        th = self.thread
        if th is not None and th.is_alive() and th is not threading.current_thread():
            th.join(2.0)
        self.thread = None

    def running(self):
        return self.thread is not None and self.thread.is_alive()

    # ----- composing -----
    def _choose(self):
        """Pick the next pitch: black keys only, not a recent note, spread away from the notes already
        sounding, and never a shape (three notes in a row) that was heard a moment ago."""
        p, rng = self.p, self.rng
        pits = [m for m in music_pitches(p) if self.bank.get((p["inst"], m, False)) is not None]
        if not pits:
            return None
        sounding = [v["midi"] for v in self.voices]
        last = self.recent
        lo, hi = min(pits), max(pits)
        cands, weights = [], []
        for m in pits:
            if m in last[-4:]:
                continue
            if last and m % 12 == last[-1] % 12:
                continue                                           # same key, other octave: too alike
            if sum(1 for x in last[-5:] if x % 12 == m % 12) >= 2:
                continue
            if len(last) >= 2 and (last[-2], last[-1], m) in self.tri:
                continue
            if len(last) >= 2 and len(self.ivs) >= 2 and m - last[-1] == self.ivs[-1] == self.ivs[-2]:
                continue                                           # no endless ladders
            w = 1.0
            if sounding:
                d = min(abs(m - s) for s in sounding)
                w *= 0.08 if d < 3 else (0.5 if d < 6 else 1.0)    # keep the voices spread out
            w *= 1.0 / (1.0 + self.reg.get(m // 12, 0.0))          # visit every octave
            if last:
                leap = abs(m - last[-1])
                w *= 1.0 if leap <= 9 else 0.6
            cands.append(m)
            weights.append(w)
        if not cands:
            cands = [m for m in pits if m not in last[-2:]] or pits
            weights = [1.0] * len(cands)
        m = rng.choices(cands, weights)[0]
        if last:
            self.ivs.append(m - last[-1])
            del self.ivs[:-6]
        if len(last) >= 2:
            self.tri.append((last[-2], last[-1], m))
            del self.tri[:-24]
        last.append(m)
        del last[:-12]
        for k in list(self.reg):
            self.reg[k] *= 0.9
        self.reg[m // 12] = self.reg.get(m // 12, 0.0) + 1.0
        return m

    def _gap(self):
        d = self.p["density"]
        mean = self._mean_gap()
        g = mean * (0.35 + min(3.0, -math.log(1.0 - self.rng.random())) * 0.65)
        if self.rng.random() < 0.10:
            g *= 0.3
        return max(0.12, g)

    def _mean_gap(self):
        """Average seconds between notes: 9 s at density 1 down to 0.28 s (3.6 notes a second) at 15."""
        return 9.0 * (0.78 ** (self.p["density"] - 1))

    def _spawn(self):
        p, rng = self.p, self.rng
        if len(self.voices) >= p["voices"]:
            return False
        m = self._choose()
        if m is None:
            return False
        long_ = rng.random() < p["long"] * 0.1
        key = (p["inst"], m, long_)
        data = self.bank.get(key)
        if data is None:
            long_ = False
            data = self.bank.get((p["inst"], m, False))
            if data is None:
                return False
        sf = max(0.15, min(1.0, 0.2 * self._mean_gap() * p["voices"]))     # busy music: shorter notes
        if long_:
            sf = max(sf, 0.35)
            hold, fade = rng.uniform(6.0, 8.0) * sf, rng.uniform(2.0, 2.8) * sf
        else:
            hold, fade = rng.uniform(1.6, 4.2) * sf, rng.uniform(1.0, 1.8) * sf
        pits = music_pitches(p)
        pos = (m - pits[0]) / float(max(1, pits[-1] - pits[0]))
        pan = max(-0.85, min(0.85, (pos - 0.5) * 0.9 + rng.uniform(-0.3, 0.3)))
        vel = rng.uniform(0.55, 1.0) * (1.0 if not long_ else 0.85)
        self.voices.append(dict(midi=m, buf=data, pos=0, hold=int(hold * MUS_RATE), fade=int(fade * MUS_RATE),
                                gl=vel * math.sqrt((1.0 - pan) / 2.0), gr=vel * math.sqrt((1.0 + pan) / 2.0)))
        return True

    # ----- rendering -----
    def _voices_block(self):
        n = MUS_N
        mix = None
        keep = []
        for v in self.voices:
            a = v["pos"]
            seg = v["buf"][a * 2:(a + n) * 2]
            if len(seg) < n * 2:
                seg += bytes(n * 2 - len(seg))
            out = []
            for s in range(4):
                fr = a + s * 128 + 64
                if fr <= v["hold"]:
                    g = 1.0
                else:
                    x = (fr - v["hold"]) / float(v["fade"])
                    g = max(0.0, 1.0 - x) ** 1.5
                out.append(_ao.mul(seg[s * 256:(s + 1) * 256], 2, g * 0.34))
            st = _ao.tostereo(b"".join(out), 2, v["gl"], v["gr"])
            mix = st if mix is None else _ao.add(mix, st, 2)
            v["pos"] = a + n
            if v["pos"] < min(v["hold"] + v["fade"], len(v["buf"]) // 2):
                keep.append(v)
        self.voices = keep
        return mix if mix is not None else self.silence

    def _phaser(self, data, mix):
        a = array.array("h")
        a.frombytes(data)
        m = mix * 0.1 * 0.6
        rate = 0.05 + 0.09 * self.p["pha_rate"]
        self.pha_ph += 2.0 * math.pi * rate * MUS_N / MUS_RATE
        keep = 1.0 - m
        for ch in (0, 1):
            lf = 0.5 + 0.5 * math.sin(self.pha_ph + ch * 1.4)
            fc = 250.0 + 1700.0 * lf * lf
            tn = math.tan(math.pi * fc / MUS_RATE)
            c = (tn - 1.0) / (tn + 1.0)
            x1, y1, x2, y2, x3, y3, x4, y4 = self.pha_st[ch]
            for i in range(ch, len(a), 2):
                s = a[i]
                y = c * s + x1 - c * y1
                x1, y1 = s, y
                z = c * y + x2 - c * y2
                x2, y2 = y, z
                y = c * z + x3 - c * y3
                x3, y3 = z, y
                z = c * y + x4 - c * y4
                x4, y4 = y, z
                r = int(s * keep + z * m)
                a[i] = 32767 if r > 32767 else (-32768 if r < -32768 else r)
            self.pha_st[ch] = [x1, y1, x2, y2, x3, y3, x4, y4]
        return a.tobytes()

    def _flanger(self, data, mix):
        rate = 0.04 + 0.05 * self.p["fla_rate"]
        self.fla_ph += 2.0 * math.pi * rate * MUS_N / MUS_RATE
        d = int(MUS_RATE * (0.0018 + 0.0014 * math.sin(self.fla_ph)))          # 0.4 .. 3.2 ms
        hist = self.dry_hist + data
        end = len(hist) - 4 * d
        delayed = hist[end - MUS_N * 4:end]
        self.dry_hist = hist[-4 * 400 - MUS_N * 4:]
        k = mix * 0.1 * 0.45
        return _ao.add(_ao.mul(data, 2, 1.0 - k * 0.5), _ao.mul(delayed, 2, k), 2)

    @staticmethod
    def _tap(buf, delay, n=MUS_N):
        """n frames (mono) that were played `delay` frames ago; buf holds the history up to now."""
        end = len(buf) - 2 * delay + 2 * n
        start = end - 2 * n
        if end <= 0:
            return bytes(2 * n)
        seg = buf[max(0, start):end]
        return bytes(2 * n - len(seg)) + seg if len(seg) < 2 * n else seg

    def _echo(self, data, mix):
        mono = _ao.tomono(data, 2, 0.5, 0.5)
        dl = max(MUS_N + 16, int(MUS_RATE * (0.12 + 0.075 * self.p["dly_time"])))
        e = self.echo[0]
        t1 = self._tap(e, dl)
        t2 = self._tap(e, int(dl * 1.5))
        new = _ao.add(mono, _ao.mul(t1, 2, 0.42), 2)
        self.echo[0] = (e + new)[-2 * int(dl * 1.5 + MUS_N * 2):]
        k = mix * 0.1 * 0.8
        wet = _ao.add(_ao.tostereo(t1, 2, k, 0.0), _ao.tostereo(t2, 2, 0.0, k), 2)
        return _ao.add(data, wet, 2)

    def _reverb(self, data, mix):
        mono = _ao.tomono(data, 2, 0.5, 0.5)
        g = 0.62 + 0.032 * self.p["rev_len"]                                 # feedback: 0.65 .. 0.94
        outs = []
        for side, delays in enumerate((self.COMB_L, self.COMB_R)):
            acc = None
            for j, ms in enumerate(delays):
                dl = int(MUS_RATE * ms / 1000.0)
                buf = self.combs[side][j]
                t = self._tap(buf, dl)
                shifted = self.comb_last[side][j].to_bytes(2, "little", signed=True) + t[:-2]
                self.comb_last[side][j] = int.from_bytes(t[-2:], "little", signed=True)
                lp = _ao.add(_ao.mul(t, 2, 0.5), _ao.mul(shifted, 2, 0.5), 2)  # darker with every pass
                y = _ao.add(mono, _ao.mul(lp, 2, g), 2)
                self.combs[side][j] = (buf + y)[-2 * 4096:]
                acc = y if acc is None else _ao.add(acc, y, 2)
            outs.append(acc)
        k = mix * 0.1 * 0.17 * (1.25 - g)
        wet = _ao.add(_ao.tostereo(outs[0], 2, k, 0.0), _ao.tostereo(outs[1], 2, 0.0, k), 2)
        return _ao.add(data, wet, 2)

    def block(self):
        """The next 23 ms of the music: 512 stereo frames of 16 bit audio."""
        p = self.p
        self.t += MUS_N
        if self.t >= self.next_on:
            if self._spawn():
                self.next_on = self.t + int(self._gap() * MUS_RATE)
            else:
                self.next_on = self.t + int(0.12 * MUS_RATE)
        x = self._voices_block()
        if p["pha_mix"]:
            x = self._phaser(x, p["pha_mix"])
        if p["fla_mix"]:
            x = self._flanger(x, p["fla_mix"])
        else:
            self.dry_hist = (self.dry_hist + x)[-4 * 400 - MUS_N * 4:]
        if p["dly_mix"]:
            x = self._echo(x, p["dly_mix"])
        else:
            self.echo[0] = (self.echo[0] + _ao.tomono(x, 2, 0.5, 0.5))[-2 * 40000:]
        x = self._reverb(x, p["rev_mix"]) if p["rev_mix"] else self._reverb(x, 0.0)
        vol = (p["vol"] / 10.0) ** 2 * 3.0
        self.fade = min(1.0, self.fade + MUS_N / (2.0 * MUS_RATE))
        return _ao.mul(x, 2, vol * self.fade)

    def render(self, seconds):
        """Offline: the music as raw stereo 16 bit data (used by tests and by the self-check)."""
        self._sync_bank()
        return b"".join(self.block() for _ in range(int(seconds * MUS_RATE / MUS_N)))

    # ----- the sound card (Windows) -----
    def _run(self):
        try:
            self._device_loop()
        except Exception as exc:                                          # never take the game down
            self.error = "%s" % exc

    def _device_loop(self):
        import ctypes
        from ctypes import wintypes
        winmm = ctypes.windll.winmm

        class WAVEFORMATEX(ctypes.Structure):
            _fields_ = [("wFormatTag", wintypes.WORD), ("nChannels", wintypes.WORD),
                        ("nSamplesPerSec", wintypes.DWORD), ("nAvgBytesPerSec", wintypes.DWORD),
                        ("nBlockAlign", wintypes.WORD), ("wBitsPerSample", wintypes.WORD),
                        ("cbSize", wintypes.WORD)]

        class WAVEHDR(ctypes.Structure):
            pass
        WAVEHDR._fields_ = [("lpData", ctypes.c_void_p), ("dwBufferLength", wintypes.DWORD),
                            ("dwBytesRecorded", wintypes.DWORD), ("dwUser", ctypes.c_size_t),
                            ("dwFlags", wintypes.DWORD), ("dwLoops", wintypes.DWORD),
                            ("lpNext", ctypes.c_void_p), ("reserved", ctypes.c_size_t)]
        HP = ctypes.POINTER(WAVEHDR)
        winmm.waveOutOpen.argtypes = [ctypes.POINTER(ctypes.c_void_p), wintypes.UINT,
                                      ctypes.POINTER(WAVEFORMATEX), ctypes.c_size_t, ctypes.c_size_t,
                                      wintypes.DWORD]
        for fn in (winmm.waveOutPrepareHeader, winmm.waveOutWrite, winmm.waveOutUnprepareHeader):
            fn.argtypes = [ctypes.c_void_p, HP, wintypes.UINT]
        winmm.waveOutReset.argtypes = [ctypes.c_void_p]
        winmm.waveOutClose.argtypes = [ctypes.c_void_p]

        fmt = WAVEFORMATEX(1, 2, MUS_RATE, MUS_RATE * 4, 4, 16, 0)
        hwo = ctypes.c_void_p()
        if winmm.waveOutOpen(ctypes.byref(hwo), 0xFFFFFFFF, ctypes.byref(fmt), 0, 0, 0) != 0:
            raise RuntimeError("no sound device")
        size = MUS_N * MUS_BUF * 4
        bufs = [ctypes.create_string_buffer(size) for _ in range(MUS_NBUF)]
        hdrs = []
        try:
            for b in bufs:
                h = WAVEHDR()
                h.lpData = ctypes.addressof(b)
                h.dwBufferLength = size
                winmm.waveOutPrepareHeader(hwo, ctypes.byref(h), ctypes.sizeof(h))
                hdrs.append(h)

            def fill(i):
                data = b"".join(self.block() for _ in range(MUS_BUF))
                ctypes.memmove(bufs[i], data, size)
                winmm.waveOutWrite(hwo, ctypes.byref(hdrs[i]), ctypes.sizeof(hdrs[i]))
            for i in range(MUS_NBUF):
                fill(i)
            while not self.stop_ev.is_set():
                busy = False
                for i in range(MUS_NBUF):
                    if hdrs[i].dwFlags & 1:                                 # WHDR_DONE: play it again
                        fill(i)
                        busy = True
                if not busy:
                    time.sleep(0.01)
        finally:
            winmm.waveOutReset(hwo)
            for h in hdrs:
                winmm.waveOutUnprepareHeader(hwo, ctypes.byref(h), ctypes.sizeof(h))
            winmm.waveOutClose(hwo)


# ---- Music settings screen: the same rows as Rainbow Runner's: (label, setting, how the value is shown)
MUS_ROWS = (
    ("Lowest octave", "oct_lo", lambda v, p: "%d   (lowest note %s)" % (v, music_note_name(music_pitches(p)[0]))),
    ("Number of octaves", "oct_n", lambda v, p: "%d   (highest note %s)" % (v, music_note_name(music_pitches(p)[-1]))),
    ("Note density", "density", lambda v, p: "%d / 15   (aims for %.1f notes a second)"
     % (v, 1.0 / (9.0 * 0.78 ** (v - 1)))),
    ("Chance of long notes", "long", lambda v, p: "%d %%" % (v * 10)),
    ("Most notes at once", "voices", lambda v, p: "%d" % v),
    ("Volume", "vol", lambda v, p: "%d / 10" % v),
    None,
    ("Reverb amount", "rev_mix", lambda v, p: "%d / 10" % v),
    ("Reverb length", "rev_len", lambda v, p: "%d / 10" % v),
    ("Echo amount", "dly_mix", lambda v, p: "%d / 10" % v),
    ("Echo time", "dly_time", lambda v, p: "%.2f s" % (0.12 + 0.075 * v)),
    ("Phaser amount", "pha_mix", lambda v, p: "%d / 10" % v),
    ("Phaser speed", "pha_rate", lambda v, p: "%.2f Hz" % (0.05 + 0.09 * v)),
    ("Flanger amount", "fla_mix", lambda v, p: "%d / 10" % v),
    ("Flanger speed", "fla_rate", lambda v, p: "%.2f Hz" % (0.04 + 0.05 * v)),
)

# The music settings are remembered in a small file next to this script.
try:
    SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mahjong_settings.json")
except NameError:                                   # pragma: no cover
    SETTINGS_FILE = "mahjong_settings.json"


def load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_settings(data):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        return True
    except Exception:
        return False


# ------------------------------------------------------------------ layout
def build_exact_layout():
    cells = []
    rows = {
        1: (2, 13), 2: (4, 11), 3: (3, 12), 4: (2, 13),
        5: (2, 13), 6: (3, 12), 7: (4, 11), 8: (2, 13),
    }
    for row, (c0, c1) in rows.items():
        for c in range(c0, c1 + 1):
            cells.append((float(c), float(row), 0))
    for c in (1, 14, 15):
        cells.append((float(c), 4.5, 0))
    assert sum(1 for c in cells if c[2] == 0) == 87

    for r in range(2, 8):
        for c in range(5, 11):
            cells.append((float(c), float(r), 1))
    assert sum(1 for c in cells if c[2] == 1) == 36

    for r in range(3, 7):
        for c in range(6, 10):
            cells.append((float(c), float(r), 2))
    assert sum(1 for c in cells if c[2] == 2) == 16

    for r in range(4, 6):
        for c in range(7, 9):
            cells.append((float(c), float(r), 3))
    assert sum(1 for c in cells if c[2] == 3) == 4

    cells.append((7.5, 4.5, 4))
    assert len(cells) == 144
    return cells


LAYOUTS = {"Exact Turtle": build_exact_layout}

TILE_TYPES = {
    "letter": list("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    "digit": list("0123456789"),
}

COLORS = {
    "red":   (190, 40, 40),
    "green": (40, 130, 55),
    "blue":  (30, 90, 190),
    "black": (50, 50, 50),
}

COLOR_ORDER = ["red", "green", "blue", "black"]

EDITOR_COLS = (0, 16)     # editor grid bounds (x)
EDITOR_ROWS = (0, 9)      # editor grid bounds (y)
EDITOR_MAX_LAYER = 4


# ------------------------------------------------------------------ custom tiles
class CustomTile:
    """
    One custom picture used for every tile of a given kind+value.
    `rotation` (clockwise degrees, multiple of 90) is applied to the whole
    source image first; `crop` is then cut from the ROTATED image.
    """

    def __init__(self, kind, value, image_path=None, crop=None, rotation=0):
        self.kind = kind
        self.value = value
        self.image_path = image_path
        self.crop = crop
        self.rotation = int(rotation or 0) % 360
        self.surface = None

    def load(self):
        self.surface = None
        if not (self.image_path and os.path.exists(self.image_path)):
            return False
        try:
            img = pygame.image.load(self.image_path).convert_alpha()
            if self.rotation:
                img = pygame.transform.rotate(img, -self.rotation)
            if self.crop:
                x, y, w, h = [int(v) for v in self.crop]
                x = max(0, min(x, img.get_width() - 1))
                y = max(0, min(y, img.get_height() - 1))
                w = max(1, min(w, img.get_width() - x))
                h = max(1, min(h, img.get_height() - y))
                img = img.subsurface(Rect(x, y, w, h))
            self.surface = pygame.transform.smoothscale(
                img, (TILE_W - TILE_INSET, TILE_H - TILE_INSET))
            return True
        except Exception as exc:
            print(f"Could not load {self.image_path}: {exc}")
            return False


def load_tileset(path):
    with open(path, "r") as fh:
        data = json.load(fh)
    ts = {"letter": {}, "digit": {}}
    for kind in ("letter", "digit"):
        for val, info in (data.get(kind) or {}).items():
            if not isinstance(info, dict):
                continue
            t = CustomTile(kind, val, info.get("path"), info.get("crop"),
                           info.get("rotation", 0))
            t.load()
            ts[kind][val] = t
    return ts


def save_tileset(ts, path):
    data = {}
    for kind in ("letter", "digit"):
        data[kind] = {v: {"path": t.image_path, "crop": t.crop,
                          "rotation": t.rotation}
                      for v, t in (ts.get(kind) or {}).items()}
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)


# ------------------------------------------------------------------ gallery image
class ImageEntry:
    """One picture in the tileset editor's gallery (max 18)."""

    def __init__(self, path, surface):
        self.path = path
        self.base = surface
        self.rotation = 0          # clockwise degrees: 0 / 90 / 180 / 270
        self.crop = None           # (x, y, w, h) in ROTATED-image coordinates
        self._rot = None
        self._thumb = None

    @property
    def name(self):
        return os.path.basename(self.path)

    def surface(self):
        """The image with its current rotation applied."""
        if self.rotation == 0:
            return self.base
        if self._rot is None or self._rot[0] != self.rotation:
            self._rot = (self.rotation,
                         pygame.transform.rotate(self.base, -self.rotation))
        return self._rot[1]

    def thumb(self, box):
        key = (self.rotation, box)
        if self._thumb is None or self._thumb[0] != key:
            s = self.surface()
            w, h = s.get_size()
            f = min(box / w, box / h)
            self._thumb = (key, pygame.transform.smoothscale(
                s, (max(1, int(w * f)), max(1, int(h * f)))))
        return self._thumb[1]

    def rotate(self, delta_cw):
        """Rotate by a multiple of 90 degrees (positive = clockwise) and
        carry the crop box along so it still covers the same picture area."""
        steps = (delta_cw // 90) % 4
        for _ in range(steps):
            _w, h = self.surface().get_size()
            if self.crop:
                x, y, cw, ch = self.crop
                self.crop = (h - (y + ch), x, ch, cw)
            self.rotation = (self.rotation + 90) % 360


# ------------------------------------------------------------------ button
class Button:
    def __init__(self, x, y, w, h, text, callback=None, size=28, fill=None):
        self.rect = Rect(x, y, w, h)
        self.text = text
        self.callback = callback
        self.font = font(size)
        self.fill = fill               # optional (r, g, b) instead of the usual purple

    def draw(self, screen):
        hovered = self.rect.collidepoint(pygame.mouse.get_pos())
        if self.fill is not None:
            color = tuple(min(255, c + 28) for c in self.fill) if hovered else self.fill
        else:
            color = (110, 110, 160) if hovered else (80, 80, 120)
        pygame.draw.rect(screen, color, self.rect, border_radius=8)
        pygame.draw.rect(screen, (255, 215, 60), self.rect, 2, border_radius=8)
        label = self.font.render(self.text, True, (255, 255, 255))
        screen.blit(label, label.get_rect(center=self.rect.center))

    def click(self, pos):
        if self.rect.collidepoint(pos):
            if self.callback:
                self.callback()
            return True
        return False


# ------------------------------------------------------------------ tile
class Tile:
    def __init__(self, gx, gy, z, kind, value, color):
        self.gx = float(gx)
        self.gy = float(gy)
        self.z = int(z)
        self.kind = kind
        self.value = value
        self.color = color
        self.visible = True
        self.selected = False
        self.free = False
        self.removing = False      # True during the green "matched" flash
        self.custom_surface = None
        self.bg_color = BG_DEFAULT
        self.border_color = BORDER_DEFAULT
        self.border_width = 2

    def set_state(self, bg, border, width):
        self.bg_color = bg
        self.border_color = border
        self.border_width = width

    def clear_state(self):
        self.set_state(BG_DEFAULT, BORDER_DEFAULT, 2)


# ------------------------------------------------------------------ game
class Game:
    def __init__(self):
        self.screen = pygame.display.set_mode((0, 0), pygame.FULLSCREEN)
        pygame.display.set_caption("Mahjong Solitaire")
        self.clock = pygame.time.Clock()
        self.running = True

        self.WIDTH, self.HEIGHT = self.screen.get_size()

        self.mode = "menu"
        self.layout_name = "Exact Turtle"
        self.tiles = []
        self.selected = None
        self.won = False

        self.custom_ts = {"letter": {}, "digit": {}}
        self.default_surfaces = {}
        self.scaled_cache = {}

        self.scale = 1.0
        self.offset_x = 0.0
        self.offset_y = 0.0
        self.origin_gx = 0.0
        self.origin_gy = 0.0
        self.board_w = 0.0
        self.board_h = 0.0

        # layout editor
        self.layout_data = None
        self.layout_edited = False
        self.editor_layer = 0

        # tileset editor
        self.images = []               # list of ImageEntry, max MAX_IMAGES
        self.image_index = 0
        self.drag_start = None         # screen coordinates while dragging
        self.drag_now = None
        self._shown_img = None
        self._shown_key = None
        self.assign_btn = None
        self.sel_kind = "letter"
        self.sel_value = "A"

        # game state
        self.match_history = []
        self.highlight_pair = []
        self.find_index = 0
        self.find_anchor = None        # tile FIND is pairing others with
        self.find_last_anchor = None
        self.quad_values = set()       # (kind, value) with all 4 tiles free
        self.pending = []
        self.locked = False

        self.notification = None
        self.notification_time = 0

        self.current_buttons = []
        self.music_buttons = []        # buttons whose label shows MUSIC: ON/OFF
        self._music_err_seen = ""

        # Rainbow Runner's ambient music, with its default sound settings.
        self.settings = load_settings()
        self.music = AmbientMusic(self.settings.get("music"))
        self.music_toggle_btn = None
        self.music_inst_btns = []
        atexit.register(self.music.stop)
        if self.music.p["on"]:
            self.music.start()
            if sys.platform == "win32" and not self.music.available:
                self.notify(self.music_problem())

        self.build_default_surfaces()
        self.show_menu()

    # ---------------------------------------------------------- tile faces
    def build_default_surfaces(self):
        for kind, values in TILE_TYPES.items():
            self.default_surfaces[kind] = {}
            for val in values:
                self.default_surfaces[kind][val] = {}
                for color in COLORS.keys():
                    self.default_surfaces[kind][val][color] = self.make_face(kind, val, color)

    def make_face(self, kind, value, color):
        surf = pygame.Surface((TILE_W - TILE_INSET, TILE_H - TILE_INSET),
                              pygame.SRCALPHA)
        f = font(66)
        glyph = f.render(value, True, COLORS[color])
        halo = f.render(value, True, (255, 255, 255))

        cx = (TILE_W - TILE_INSET) // 2
        cy = (TILE_H - TILE_INSET) // 2
        grect = glyph.get_rect(center=(cx, cy))

        for dx, dy in ((-3, 0), (3, 0), (0, -3), (0, 3),
                       (-2, -2), (2, 2), (-2, 2), (2, -2)):
            surf.blit(halo, grect.move(dx, dy))
        surf.blit(glyph, grect)
        return surf

    def apply_face(self, tile):
        """Attach the custom picture (if any) for this tile's kind+value."""
        custom = self.custom_ts.get(tile.kind, {}).get(tile.value)
        if custom is not None and custom.surface is None:
            custom.load()
        tile.custom_surface = custom.surface if custom is not None else None

    # ---------------------------------------------------------- buttons
    def show_menu(self):
        self.mode = "menu"
        self.pending = []
        self.locked = False
        self.drag_start = None
        self.drag_now = None
        cx = self.WIDTH // 2
        # Title and subtitle sit at the top; the buttons start below them.
        self.menu_title_y = max(70, int(self.HEIGHT * 0.20))
        top = self.menu_title_y + 52 + 70
        step = 70
        self.music_buttons = []
        self.current_buttons = [
            Button(cx - 150, top, 300, 55, "PLAY", self.start_game),
            Button(cx - 150, top + step, 300, 55, "LAYOUT EDITOR", self.start_layout_editor),
            Button(cx - 150, top + step * 2, 300, 55, "TILESET EDITOR", self.start_tileset_editor),
            Button(cx - 150, top + step * 3, 300, 55, "MUSIC", self.start_music_screen),
            Button(cx - 150, top + step * 4, 300, 55, "QUIT", lambda: setattr(self, "running", False)),
        ]

    # ---------------------------------------------------------- music
    def make_music_button(self, x, y, w, h):
        """A button that turns the music on/off and always shows its state."""
        b = Button(x, y, w, h, "", self.toggle_music)
        self.music_buttons.append(b)
        self.refresh_music_labels()
        return b

    def refresh_music_labels(self):
        text = "MUSIC: ON" if self.music.p["on"] else "MUSIC: OFF"
        for b in self.music_buttons:
            b.text = text

    def music_problem(self):
        """Why music can't play right now, or '' if it can."""
        mu = self.music
        if sys.platform != "win32":
            return "Music plays on Windows only."
        if not mu.available:
            return "Music needs the 'audioop' module - run:  py -m pip install audioop-lts"
        if mu.error:
            return "Sound problem: %s" % mu.error
        return ""

    def save_music_settings(self):
        self.settings["music"] = dict(self.music.p)
        save_settings(self.settings)

    def toggle_music(self):
        mu = self.music
        on = not mu.p["on"]
        mu.set(on=on)
        if on:
            mu.start()
            problem = self.music_problem()
            self.notify(problem if problem else "Music on")
        else:
            mu.stop()
            self.notify("Music off")
        self.refresh_music_labels()
        self.save_music_settings()

    # ---------------------------------------------------------- music settings screen
    # A copy of Rainbow Runner's music screen: same rows, same limits, same buttons, same notes.
    def start_music_screen(self):
        self.show_music_ui()

    def music_geometry(self):
        """Positions on the music screen. Same offsets as Rainbow Runner (it centres a 780 px tall page)."""
        cx = self.WIDTH // 2
        oy = max(0, (self.HEIGHT - 780) // 2)
        step = 29 if self.HEIGHT >= 720 else max(20, (self.HEIGHT - 330) // 14)   # squeeze on short screens
        toggle_y = 96 + oy
        inst_y = toggle_y + 40
        y = inst_y + 42
        rows = []
        for row in MUS_ROWS:
            rows.append((row, y))
            y += 22 if row is None else step
        return dict(cx=cx, oy=oy, x0=cx - 330, toggle_y=toggle_y, inst_y=inst_y, rows=rows, end_y=y + 8,
                    pm_h=min(24, step - 2))

    def show_music_ui(self):
        self.mode = "music"
        self.music_buttons = []
        g = self.music_geometry()
        x0 = g["x0"]
        grey = (42, 48, 66)
        self.music_toggle_btn = Button(x0, g["toggle_y"], 140, 30, "", self.toggle_music, size=24, fill=grey)
        btns = [self.music_toggle_btn]
        self.music_inst_btns = []
        for q, nm in enumerate(MUS_INSTRUMENTS):
            b = Button(x0 + 190 + q * 112, g["inst_y"], 106, 30, nm,
                       lambda n=nm: self.set_instrument(n), size=22, fill=grey)
            btns.append(b)
            self.music_inst_btns.append((b, nm))
        for row, y in g["rows"]:
            if row is None:
                continue
            key = row[1]
            btns.append(Button(x0 + 190, y, 28, g["pm_h"], "-", lambda k=key: self.adjust_music(k, -1),
                               size=26, fill=grey))
            btns.append(Button(x0 + 434, y, 28, g["pm_h"], "+", lambda k=key: self.adjust_music(k, 1),
                               size=26, fill=grey))
        btns.append(Button(x0, g["end_y"], 200, 32, "Reset to defaults", self.reset_music, size=24, fill=grey))
        btns.append(Button(x0 + 460, g["end_y"], 200, 32, "Back  [Esc]", self.show_menu,
                           size=24, fill=(45, 106, 58)))
        self.current_buttons = btns

    def set_instrument(self, name):
        self.music.set(inst=name)
        self.save_music_settings()

    def adjust_music(self, key, delta):
        self.music.set(**{key: self.music.p[key] + delta})
        self.save_music_settings()

    def reset_music(self):
        self.music.set(**dict(MUS_DEFAULTS, on=self.music.p["on"]))
        self.save_music_settings()

    def music_screen_notes(self):
        """The orange note under the buttons (same wording as Rainbow Runner)."""
        mu = self.music
        if sys.platform != "win32":
            return ["Music plays on Windows only."]
        if not mu.available:
            return ["This Python has no 'audioop' module (it was removed in Python 3.13): music is off.",
                    "To get music, run:  py -m pip install audioop-lts"]
        if mu.error:
            return ["Sound problem: %s" % mu.error]
        return []

    def draw_music(self):
        mu = self.music
        p = mu.p
        g = self.music_geometry()
        cx, x0, oy = g["cx"], g["x0"], g["oy"]
        label_font, small = font(24), font(20)
        value_font = _bold_font(24)
        white, soft, dim = (207, 212, 222), (170, 176, 192), (138, 144, 164)

        t = _bold_font(56).render("MUSIC", True, (255, 255, 255))
        self.screen.blit(t, t.get_rect(center=(cx, 36 + oy)))
        t = font(22).render("Ambient and zen: random notes on the black keys only. "
                            "It changes as you adjust it.", True, dim)
        self.screen.blit(t, t.get_rect(center=(cx, 66 + oy + 8)))

        if self.music_toggle_btn is not None:
            self.music_toggle_btn.text = "Music: %s" % ("ON" if p["on"] else "OFF")
            self.music_toggle_btn.fill = (45, 106, 58) if p["on"] else (42, 48, 66)
        t = font(22).render("(M turns it on or off at any time)", True, soft)
        self.screen.blit(t, t.get_rect(midleft=(x0 + 156, g["toggle_y"] + 15)))

        t = label_font.render("Instrument", True, white)
        self.screen.blit(t, t.get_rect(midleft=(x0, g["inst_y"] + 15)))
        for b, nm in self.music_inst_btns:
            chosen = p["inst"] == nm
            b.fill = (59, 53, 96) if chosen else (42, 48, 66)
            if chosen:
                pygame.draw.rect(self.screen, (255, 213, 79), b.rect.inflate(4, 4), 3, border_radius=9)

        for row, y in g["rows"]:
            if row is None:
                t = small.render("EFFECTS", True, (165, 173, 194))
                self.screen.blit(t, t.get_rect(midleft=(x0, y + 8)))
                pygame.draw.line(self.screen, (50, 56, 73), (x0 + 64, y + 8), (x0 + 660, y + 8))
                continue
            label, key, fmt = row
            lo, hi = MUS_LIMITS[key]
            v = p[key]
            t = label_font.render(label, True, white)
            self.screen.blit(t, t.get_rect(midleft=(x0, y + 12)))
            bar = Rect(x0 + 226, y + 6, 200, 12)
            pygame.draw.rect(self.screen, (23, 26, 36), bar)
            frac = (v - lo) / float(max(1, hi - lo))
            pygame.draw.rect(self.screen, (108, 140, 255), Rect(bar.x, bar.y, int(bar.w * frac), bar.h))
            pygame.draw.rect(self.screen, (58, 65, 86), bar, 1)
            t = value_font.render(fmt(v, p), True, (255, 255, 255))
            self.screen.blit(t, t.get_rect(midleft=(x0 + 474, y + 12)))

        for i, line in enumerate(self.music_screen_notes()):
            t = label_font.render(line, True, (255, 184, 107))
            self.screen.blit(t, t.get_rect(center=(cx, g["end_y"] + 52 + i * 26)))

    def show_game_ui(self):
        self.mode = "game"
        self.music_buttons = []
        self.current_buttons = [Button(30, 30, 130, 42, "MENU", self.show_menu)]

        btn_w, btn_h, gap = 120, 50, 10
        bottom_y = self.HEIGHT - 75
        start_x = 30
        self.current_buttons.extend([
            Button(start_x, bottom_y, btn_w, btn_h, "FIND", self.find_move),
            Button(start_x + btn_w + gap, bottom_y, btn_w, btn_h, "UNDO", self.undo_move),
            Button(start_x + (btn_w + gap) * 2, bottom_y, btn_w, btn_h, "SHUFFLE", self.reshuffle),
            Button(start_x + (btn_w + gap) * 3, bottom_y, btn_w, btn_h, "NEW", self.new_deal),
            self.make_music_button(start_x + (btn_w + gap) * 4, bottom_y, 170, btn_h),
        ])

    def show_editor_ui(self):
        self.mode = "editor"
        if not self.layout_data:
            self.layout_data = [list(c) for c in LAYOUTS[self.layout_name]()]
        self.editor_layer = 0
        self.set_view(EDITOR_COLS[0], EDITOR_COLS[1],
                      EDITOR_ROWS[0], EDITOR_ROWS[1], EDITOR_MAX_LAYER)
        self.current_buttons = [
            Button(30, 30, 110, 42, "MENU", self.show_menu),
            Button(self.WIDTH - 355, 30, 105, 42, "RESET", self.reset_layout),
            Button(self.WIDTH - 240, 30, 105, 42, "SAVE", self.save_layout),
            Button(self.WIDTH - 125, 30, 105, 42, "LOAD", self.load_layout),
        ]

    def show_tileset_ui(self):
        self.mode = "tileset"
        self.drag_start = None
        self.drag_now = None
        W = self.WIDTH
        self.assign_btn = Button(890, 88, 190, 42, "ASSIGN", self.assign_crop)
        self.current_buttons = [
            # top row
            Button(30, 30, 110, 42, "MENU", self.show_menu),
            Button(W - 570, 30, 170, 42, "ADD IMAGES", self.add_images),
            Button(W - 390, 30, 170, 42, "REMOVE IMAGE", self.remove_image),
            Button(W - 210, 30, 90, 42, "SAVE", self.save_ts),
            Button(W - 110, 30, 90, 42, "OPEN", self.load_ts),
            # second row, above the picture
            Button(420, 88, 50, 42, "<", self.prev_image),
            Button(476, 88, 50, 42, ">", self.next_image),
            Button(540, 88, 160, 42, "ROTATE LEFT", self.rotate_left),
            Button(710, 88, 170, 42, "ROTATE RIGHT", self.rotate_right),
            self.assign_btn,
            Button(1090, 88, 160, 42, "CLEAR VALUE", self.clear_value),
        ]

    def start_game(self):
        self.show_game_ui()
        self.new_deal()

    def start_layout_editor(self):
        self.show_editor_ui()

    def start_tileset_editor(self):
        self.show_tileset_ui()

    # ---------------------------------------------------------- dealing
    def get_cells(self):
        raw = self.layout_data if (self.layout_edited and self.layout_data) \
            else LAYOUTS[self.layout_name]()
        return [(float(c[0]), float(c[1]), int(c[2])) for c in raw]

    def make_pairs(self, n):
        """n pairs of faces; each pair shares kind+value (colours differ)."""
        base = []
        for kind, values in TILE_TYPES.items():
            for v in values:
                base.append(((kind, v, "red"), (kind, v, "green")))
                base.append(((kind, v, "blue"), (kind, v, "black")))
        pairs = []
        while len(pairs) < n:
            chunk = base[:]
            random.shuffle(chunk)
            pairs.extend(chunk)
        return pairs[:n]

    def deal_solvable(self, tiles, pairs, attempts=300):
        """
        Assign faces so the board is guaranteed solvable: simulate removing
        free tiles two at a time, giving each removed pair one matching pair
        of faces. Replaying that order clears the board.
        """
        for _ in range(attempts):
            for t in tiles:
                t.visible = True
            order = []
            ok = True
            for _p in pairs:
                self.update_free()
                free = [t for t in tiles if t.visible and t.free]
                if len(free) < 2:
                    ok = False
                    break
                a, b = random.sample(free, 2)
                a.visible = False
                b.visible = False
                order.append((a, b))
            if ok:
                for (a, b), (fa, fb) in zip(order, pairs):
                    a.kind, a.value, a.color = fa
                    b.kind, b.value, b.color = fb
                for t in tiles:
                    t.visible = True
                return True
        for t in tiles:
            t.visible = True
        return False

    def reset_find_state(self):
        self.find_index = 0
        self.find_anchor = None
        self.find_last_anchor = None

    def new_deal(self):
        self.won = False
        self.selected = None
        self.match_history = []
        self.highlight_pair = []
        self.reset_find_state()
        self.pending = []
        self.locked = False
        self.quad_values = set()
        self.scaled_cache.clear()

        cells = self.get_cells()
        if len(cells) % 2:
            cells = cells[:-1]
            self.notify("Layout had an odd tile count - one tile dropped")
        if len(cells) < 2:
            self.tiles = []
            self.notify("Layout has too few tiles")
            return

        self.tiles = [Tile(gx, gy, z, "letter", "A", "red") for gx, gy, z in cells]
        pairs = self.make_pairs(len(cells) // 2)

        if not self.deal_solvable(self.tiles, pairs):
            faces = [f for pair in pairs for f in pair]
            random.shuffle(faces)
            for t, (kind, value, color) in zip(self.tiles, faces):
                t.kind, t.value, t.color = kind, value, color
            self.notify("Could not guarantee a solvable deal - dealt randomly")

        for t in self.tiles:
            t.visible = True
            t.clear_state()
            self.apply_face(t)

        self.recalculate_view()
        self.update_free()
        self.refresh_quads()

    # ---------------------------------------------------------- geometry
    def set_view(self, min_gx, max_gx, min_gy, max_gy, max_z):
        board_w = (max_gx - min_gx + 1) * TILE_W + max_z * LAYER_DX
        board_h = (max_gy - min_gy + 1) * TILE_H + max_z * LAYER_DY

        top_margin = 115
        bottom_margin = 135
        available_w = self.WIDTH - 100
        available_h = self.HEIGHT - top_margin - bottom_margin

        self.scale = min(1.0, available_w / board_w, available_h / board_h)

        self.board_w = board_w * self.scale
        self.board_h = board_h * self.scale
        self.origin_gx = min_gx
        self.origin_gy = min_gy
        self.offset_x = (self.WIDTH - self.board_w) / 2
        self.offset_y = top_margin + (available_h - self.board_h) / 2

    def recalculate_view(self):
        cells = [(t.gx, t.gy, t.z) for t in self.tiles] or self.get_cells()
        if not cells:
            return
        self.set_view(min(c[0] for c in cells), max(c[0] for c in cells),
                      min(c[1] for c in cells), max(c[1] for c in cells),
                      max(c[2] for c in cells))

    def cell_rect(self, gx, gy, z):
        s = self.scale
        x = self.offset_x + (gx - self.origin_gx) * TILE_W * s + z * LAYER_DX * s
        y = self.offset_y + (gy - self.origin_gy) * TILE_H * s - z * LAYER_DY * s
        return Rect(int(x), int(y),
                    int((TILE_W - TILE_INSET) * s),
                    int((TILE_H - TILE_INSET) * s))

    def tile_rect(self, tile):
        return self.cell_rect(tile.gx, tile.gy, tile.z)

    # ---------------------------------------------------------- rules
    def update_free(self):
        """
        A tile is free if nothing sits on top of it AND it is not blocked on
        both its left and right. Positions are compared in half-cell units so
        the half-row side tiles (the turtle's 'ears') block correctly.
        """
        occ = set()
        max_z = 0
        for t in self.tiles:
            if t.visible:
                occ.add((t.z, round(t.gx * 2), round(t.gy * 2)))
                if t.z > max_z:
                    max_z = t.z

        for t in self.tiles:
            if not t.visible:
                t.free = False
                continue
            kx = round(t.gx * 2)
            ky = round(t.gy * 2)
            covered = any((z, kx + dx, ky + dy) in occ
                          for z in range(t.z + 1, max_z + 1)
                          for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            if covered:
                t.free = False
                continue
            left = any((t.z, kx - 2, ky + dy) in occ for dy in (-1, 0, 1))
            right = any((t.z, kx + 2, ky + dy) in occ for dy in (-1, 0, 1))
            t.free = not (left and right)

    def can_match(self, a, b):
        if a is b:
            return False
        return a.kind == b.kind and a.value == b.value

    def free_tiles(self):
        return [t for t in self.tiles if t.visible and t.free]

    def all_pairs(self):
        free = self.free_tiles()
        return [(a, b) for i, a in enumerate(free) for b in free[i + 1:]
                if self.can_match(a, b)]

    def find_pair(self):
        free = self.free_tiles()
        for i, a in enumerate(free):
            for b in free[i + 1:]:
                if self.can_match(a, b):
                    return (a, b)
        return None

    def count_moves(self):
        """
        Number of distinct matching pairs among the free tiles right now.
        This is exactly the number of presses FIND needs to cycle through
        every match and come back to the first one: for each face value
        with n free tiles there are n*(n-1)/2 pairs (4 free copies = 6).
        Tiles already matched and mid-flash ("removing") are not counted.
        """
        groups = {}
        for t in self.tiles:
            if t.visible and t.free and not t.removing:
                key = (t.kind, t.value)
                groups[key] = groups.get(key, 0) + 1
        return sum(n * (n - 1) // 2 for n in groups.values())

    def quad_set(self):
        """Face values (kind, value) whose four tiles are ALL free right now."""
        groups = {}
        for t in self.tiles:
            if t.visible and t.free and not t.removing:
                key = (t.kind, t.value)
                groups[key] = groups.get(key, 0) + 1
        return {k for k, n in groups.items() if n >= 4}

    def refresh_quads(self):
        """Recompute which values have all four tiles free (shown in the HUD)."""
        self.quad_values = self.quad_set()

    # ---------------------------------------------------------- scheduling
    def schedule(self, delay_ms, fn):
        self.pending.append((pygame.time.get_ticks() + delay_ms, fn))

    def process_pending(self):
        if not self.pending:
            return
        now = pygame.time.get_ticks()
        due = [item for item in self.pending if item[0] <= now]
        self.pending = [item for item in self.pending if item[0] > now]
        for _, fn in due:
            fn()

    # ---------------------------------------------------------- actions
    def clear_selection(self):
        if self.selected:
            self.selected.selected = False
            self.selected.clear_state()
            self.selected = None

    def clear_highlight(self):
        for t in self.highlight_pair:
            t.selected = False
            t.clear_state()
        self.highlight_pair = []

    def find_move(self):
        """
        FIND with a tile selected: highlight that tile plus a free match for
        it (press again to cycle through the other free matches).
        FIND with nothing selected: highlight a matching pair (press again
        for the next one). Click a highlighted tile to remove the pair.
        """
        if self.locked or self.mode != "game":
            return

        anchor = self.selected
        from_selection = anchor is not None
        if anchor is None and self.find_anchor is not None \
                and self.find_anchor in self.highlight_pair:
            anchor = self.find_anchor        # keep cycling around the same tile

        self.clear_highlight()               # old yellow tiles go back to white
        if from_selection:
            # The selection becomes part of the highlighted pair.
            anchor.selected = False
            anchor.clear_state()
            self.selected = None

        if anchor is not None:
            partners = [t for t in self.free_tiles() if self.can_match(anchor, t)]
            if not partners:
                # Nothing to pair with: the tile is deselected and flashes
                # red, then goes back to plain white.
                self.find_anchor = None
                anchor.selected = False
                anchor.set_state(BG_MISMATCH, BORDER_MISMATCH, 4)

                def restore(t=anchor):
                    # Skip if the player already clicked it again meanwhile.
                    if t.visible and t.bg_color == BG_MISMATCH and t is not self.selected:
                        t.clear_state()

                self.schedule(FLASH_MISMATCH_MS, restore)
                self.notify(f"No free match for {anchor.value} right now")
                return
            if anchor is not self.find_last_anchor:
                self.find_index = 0
            self.find_last_anchor = anchor
            self.find_anchor = anchor
            pos = self.find_index % len(partners)
            pair = (anchor, partners[pos])
            message = (f"Match for {anchor.value} highlighted "
                       f"(option {pos + 1} of {len(partners)}) - click to remove")
        else:
            pairs = self.all_pairs()
            if not pairs:
                self.notify("No moves left - try SHUFFLE")
                return
            if self.find_last_anchor is not None:
                self.find_index = 0
            self.find_last_anchor = None
            self.find_anchor = None
            pos = self.find_index % len(pairs)
            pair = pairs[pos]
            message = "Match highlighted - click one of them to remove"

        self.find_index += 1
        for t in pair:
            t.selected = True
            t.set_state(BG_SELECTED, BORDER_SELECTED, 4)
        self.highlight_pair = list(pair)
        self.notify(message)

    def undo_move(self):
        if self.locked or self.mode != "game":
            return
        if not self.match_history:
            self.notify("Nothing to undo")
            return
        self.clear_selection()
        self.clear_highlight()

        for tile in self.match_history.pop():
            tile.visible = True
            tile.selected = False
            tile.removing = False
            tile.clear_state()

        self.won = False
        self.reset_find_state()
        self.update_free()
        self.refresh_quads()
        self.notify("Undone")

    def reshuffle(self):
        if self.locked or self.mode != "game":
            return
        self.clear_selection()
        self.clear_highlight()

        visible = [t for t in self.tiles if t.visible]
        if len(visible) < 2:
            self.notify("Not enough tiles to shuffle")
            return

        # Rebuild matching pairs from the faces still on the board.
        groups = {}
        for t in visible:
            groups.setdefault((t.kind, t.value), []).append((t.kind, t.value, t.color))
        pairs = []
        leftovers = []
        for faces in groups.values():
            random.shuffle(faces)
            while len(faces) >= 2:
                pairs.append((faces.pop(), faces.pop()))
            leftovers.extend(faces)

        done = False
        if not leftovers:
            done = self.deal_solvable(visible, pairs, attempts=200)

        if not done:
            faces = [(t.kind, t.value, t.color) for t in visible]
            for _ in range(200):
                random.shuffle(faces)
                for t, (kind, value, color) in zip(visible, faces):
                    t.kind, t.value, t.color = kind, value, color
                self.update_free()
                if self.find_pair() is not None:
                    done = True
                    break

        for t in visible:
            t.visible = True
            self.apply_face(t)

        self.reset_find_state()
        self.scaled_cache.clear()
        self.update_free()
        self.refresh_quads()
        self.notify("Shuffled" if done else "Shuffled - no matching moves possible")

    def finish_match(self, t1, t2):
        self.match_history.append([t1, t2])
        for t in (t1, t2):
            t.visible = False
            t.selected = False
            t.removing = False
            t.clear_state()
        self.locked = False
        self.reset_find_state()

        self.update_free()
        self.refresh_quads()

        if not any(t.visible for t in self.tiles):
            self.won = True
            self.notify("Board cleared!")
        elif self.find_pair() is None:
            self.notify("No moves left - use UNDO or SHUFFLE")

    def flash_mismatch(self, t1, t2):
        for t in (t1, t2):
            t.selected = False
            t.set_state(BG_MISMATCH, BORDER_MISMATCH, 4)
        self.locked = True

        def reset():
            for t in (t1, t2):
                t.clear_state()
            self.locked = False

        self.schedule(FLASH_MISMATCH_MS, reset)

    # ---------------------------------------------------------- clicking
    def click_tile(self, tile):
        if self.locked:
            return

        # Clicking a FIND-highlighted tile removes the highlighted pair.
        if tile in self.highlight_pair:
            other = self.highlight_pair[0] if self.highlight_pair[1] is tile \
                else self.highlight_pair[1]
            self.clear_highlight()
            self.finish_match(tile, other)
            return

        # Clicking anything else clears the highlight (tiles go white).
        if self.highlight_pair:
            self.clear_highlight()

        if not tile.free:
            self.notify("That tile is blocked.")
            return

        if self.selected is tile:
            tile.selected = False
            tile.clear_state()
            self.selected = None
            return

        if self.selected is None:
            tile.selected = True
            tile.set_state(BG_SELECTED, BORDER_SELECTED, 4)
            self.selected = tile
            return

        first = self.selected

        if self.can_match(first, tile):
            first.selected = False
            first.removing = True
            tile.removing = True
            first.set_state(BG_MATCHING, BORDER_MATCHING, 4)
            tile.set_state(BG_MATCHING, BORDER_MATCHING, 4)
            self.selected = None
            self.locked = True
            self.schedule(FLASH_MATCH_MS, lambda: self.finish_match(first, tile))
        else:
            self.selected = None
            self.flash_mismatch(first, tile)

    def tile_at(self, pos):
        for tile in sorted(self.tiles, key=lambda t: (t.z, t.gy, t.gx), reverse=True):
            if tile.visible and self.tile_rect(tile).collidepoint(pos):
                return tile
        return None

    # ---------------------------------------------------------- events
    def handle_events(self):
        for event in pygame.event.get():
            if event.type == QUIT:
                self.running = False
                return

            elif event.type == MOUSEBUTTONDOWN:
                if event.button == 1:
                    if any(b.click(event.pos) for b in list(self.current_buttons)):
                        continue
                    if self.mode == "game":
                        tile = self.tile_at(event.pos)
                        if tile:
                            self.click_tile(tile)
                    elif self.mode == "editor":
                        half = bool(pygame.key.get_mods() & KMOD_SHIFT)
                        self.editor_click(event.pos, remove=False, half=half)
                    elif self.mode == "tileset":
                        self.tileset_press(event.pos)
                elif event.button == 3 and self.mode == "editor":
                    self.editor_click(event.pos, remove=True, half=False)
                elif event.button == 4 and self.mode == "editor":
                    self.editor_layer = min(EDITOR_MAX_LAYER, self.editor_layer + 1)
                elif event.button == 5 and self.mode == "editor":
                    self.editor_layer = max(0, self.editor_layer - 1)

            elif event.type == MOUSEMOTION:
                if self.mode == "tileset":
                    self.tileset_motion(event.pos)

            elif event.type == MOUSEBUTTONUP:
                if event.button == 1 and self.mode == "tileset":
                    self.tileset_release(event.pos)

            elif event.type == KEYDOWN:
                if event.key == K_ESCAPE and self.mode != "menu":
                    self.show_menu()
                elif self.mode == "menu" and event.key == K_q:
                    self.running = False
                elif event.key == K_m:
                    self.toggle_music()
                elif self.mode == "game":
                    if event.key == K_f:
                        self.find_move()
                    elif event.key == K_u:
                        self.undo_move()
                    elif event.key == K_s:
                        self.reshuffle()
                    elif event.key == K_n:
                        self.new_deal()
                elif self.mode == "editor":
                    if event.key == K_UP:
                        self.editor_layer = min(EDITOR_MAX_LAYER, self.editor_layer + 1)
                    elif event.key == K_DOWN:
                        self.editor_layer = max(0, self.editor_layer - 1)
                elif self.mode == "tileset":
                    if event.key == K_LEFT:
                        self.prev_image()
                    elif event.key == K_RIGHT:
                        self.next_image()
                    elif event.key == K_LEFTBRACKET:
                        self.rotate_left()
                    elif event.key == K_RIGHTBRACKET:
                        self.rotate_right()

    # ---------------------------------------------------------- layout editor
    def editor_click(self, pos, remove, half):
        if self.layout_data is None:
            return
        if remove:
            for cell in sorted(self.layout_data,
                               key=lambda c: (c[2], c[1], c[0]), reverse=True):
                if self.cell_rect(cell[0], cell[1], cell[2]).collidepoint(pos):
                    self.layout_data.remove(cell)
                    self.layout_edited = True
                    return
            return

        z = self.editor_layer
        s = self.scale
        fx = (pos[0] - self.offset_x - z * LAYER_DX * s) / (TILE_W * s) + self.origin_gx
        fy = (pos[1] - self.offset_y + z * LAYER_DY * s) / (TILE_H * s) + self.origin_gy
        step = 0.5 if half else 1.0
        gx = round((fx - 0.47) / step) * step
        gy = round((fy - 0.47) / step) * step
        gx = max(EDITOR_COLS[0], min(EDITOR_COLS[1], gx))
        gy = max(EDITOR_ROWS[0], min(EDITOR_ROWS[1], gy))

        cell = [float(gx), float(gy), z]
        if cell not in self.layout_data:
            self.layout_data.append(cell)
            self.layout_edited = True

    def reset_layout(self):
        self.layout_data = [list(c) for c in LAYOUTS[self.layout_name]()]
        self.layout_edited = False
        self.notify("Layout reset to Exact Turtle")

    # ---------------------------------------------------------- tileset editor
    def cur(self):
        """The image currently shown in the tileset editor, or None."""
        if not self.images:
            return None
        self.image_index = max(0, min(self.image_index, len(self.images) - 1))
        return self.images[self.image_index]

    def next_image(self):
        if self.images:
            self.image_index = (self.image_index + 1) % len(self.images)
            self.drag_start = self.drag_now = None

    def prev_image(self):
        if self.images:
            self.image_index = (self.image_index - 1) % len(self.images)
            self.drag_start = self.drag_now = None

    def rotate_left(self):
        e = self.cur()
        if e is None:
            self.notify("Add an image first")
            return
        e.rotate(-90)
        self.drag_start = self.drag_now = None
        self.notify(f"Rotated left - now {e.rotation} deg")

    def rotate_right(self):
        e = self.cur()
        if e is None:
            self.notify("Add an image first")
            return
        e.rotate(90)
        self.drag_start = self.drag_now = None
        self.notify(f"Rotated right - now {e.rotation} deg")

    def palette_boxes(self):
        """Returns (boxes, letters_label_y, digits_label_y, preview_y)."""
        boxes = []
        x0, y0 = 30, 150
        bw, bh, gap, cols = 52, 38, 4, 6
        for i, v in enumerate(TILE_TYPES["letter"]):
            r, c = divmod(i, cols)
            boxes.append((Rect(x0 + c * (bw + gap), y0 + r * (bh + gap), bw, bh),
                          "letter", v))
        rows_l = (len(TILE_TYPES["letter"]) + cols - 1) // cols
        y1 = y0 + rows_l * (bh + gap) + 40
        for i, v in enumerate(TILE_TYPES["digit"]):
            r, c = divmod(i, cols)
            boxes.append((Rect(x0 + c * (bw + gap), y1 + r * (bh + gap), bw, bh),
                          "digit", v))
        rows_d = (len(TILE_TYPES["digit"]) + cols - 1) // cols
        preview_y = y1 + rows_d * (bh + gap) + 40
        return boxes, y0 - 24, y1 - 24, preview_y

    def thumb_rects(self):
        """[(Rect, index)] for the thumbnail strip above the picture."""
        n = len(self.images)
        if n == 0:
            return []
        avail = self.WIDTH - 420 - 30
        box = max(24, min(56, avail // MAX_IMAGES - 4))
        return [(Rect(420 + i * (box + 4), 162, box, box), i) for i in range(n)]

    def tileset_view(self):
        """(x, y, factor, w, h) of the displayed picture, or None."""
        e = self.cur()
        if e is None:
            return None
        iw, ih = e.surface().get_size()
        dx, dy = 420, 228
        avail_w = max(50, self.WIDTH - dx - 30)
        avail_h = max(50, self.HEIGHT - dy - 80)
        factor = min(avail_w / iw, avail_h / ih, 3.0)
        return dx, dy, factor, max(1, int(iw * factor)), max(1, int(ih * factor))

    def tileset_press(self, pos):
        boxes, _a, _b, _c = self.palette_boxes()
        for rect, kind, val in boxes:
            if rect.collidepoint(pos):
                self.sel_kind, self.sel_value = kind, val
                return
        for rect, idx in self.thumb_rects():
            if rect.collidepoint(pos):
                self.image_index = idx
                self.drag_start = self.drag_now = None
                return
        view = self.tileset_view()
        if view:
            dx, dy, _f, dw, dh = view
            if Rect(dx, dy, dw, dh).collidepoint(pos):
                self.drag_start = pos
                self.drag_now = pos

    def tileset_motion(self, pos):
        if self.drag_start:
            self.drag_now = pos

    def tileset_release(self, pos):
        if not self.drag_start:
            return
        x0, y0 = self.drag_start
        x1, y1 = pos
        self.drag_start = None
        self.drag_now = None
        view = self.tileset_view()
        e = self.cur()
        if not view or e is None:
            return
        dx, dy, f, _dw, _dh = view
        iw, ih = e.surface().get_size()

        def clamp(v, hi):
            return max(0.0, min(float(hi), v))

        ix0 = clamp((min(x0, x1) - dx) / f, iw)
        iy0 = clamp((min(y0, y1) - dy) / f, ih)
        ix1 = clamp((max(x0, x1) - dx) / f, iw)
        iy1 = clamp((max(y0, y1) - dy) / f, ih)
        w, h = ix1 - ix0, iy1 - iy0
        if w >= 4 and h >= 4:
            e.crop = (int(ix0), int(iy0), int(w), int(h))
            self.notify("Crop set - pick a letter/digit, then ASSIGN")

    def assign_crop(self):
        e = self.cur()
        if e is None:
            self.notify("Add an image first (ADD IMAGES)")
            return
        tile = CustomTile(self.sel_kind, self.sel_value, e.path,
                          list(e.crop) if e.crop else None, e.rotation)
        if tile.load():
            self.custom_ts.setdefault(self.sel_kind, {})[self.sel_value] = tile
            self.scaled_cache.clear()
            what = "crop" if e.crop else "whole image"
            self.notify(f"Assigned {what} to {self.sel_kind} {self.sel_value}")
        else:
            self.notify("Could not load that image region")

    def clear_value(self):
        if self.custom_ts.get(self.sel_kind, {}).pop(self.sel_value, None) is not None:
            self.scaled_cache.clear()
            self.notify(f"Cleared {self.sel_kind} {self.sel_value}")
        else:
            self.notify("Nothing assigned to that value")

    def add_images(self):
        room = MAX_IMAGES - len(self.images)
        if room <= 0:
            self.notify(f"{MAX_IMAGES} image limit reached - REMOVE IMAGE first")
            return
        paths = self._dialog_multi([("Images", "*.png *.jpg *.jpeg *.bmp *.gif"),
                                    ("All files", "*.*")])
        if not paths:
            return
        skipped_limit = max(0, len(paths) - room)
        paths = paths[:room]
        first_new = len(self.images)
        failed = 0
        for p in paths:
            try:
                surf = pygame.image.load(p).convert_alpha()
                self.images.append(ImageEntry(p, surf))
            except Exception as exc:
                print(f"Could not load {p}: {exc}")
                failed += 1
        added = len(self.images) - first_new
        if added:
            self.image_index = first_new
            self.drag_start = self.drag_now = None
        msg = f"Added {added} image{'s' if added != 1 else ''}"
        if skipped_limit:
            msg += f" ({skipped_limit} skipped - limit {MAX_IMAGES})"
        if failed:
            msg += f" ({failed} could not be read)"
        self.notify(msg)

    def remove_image(self):
        e = self.cur()
        if e is None:
            self.notify("No image to remove")
            return
        del self.images[self.image_index]
        self.image_index = max(0, min(self.image_index, len(self.images) - 1))
        self.drag_start = self.drag_now = None
        self.notify(f"Removed {e.name}")

    # ---------------------------------------------------------- dialogs
    def _dialog(self, save=False, patterns=None):
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)   # keep dialog above fullscreen game
        except Exception:
            pass
        root.update()
        if save:
            path = filedialog.asksaveasfilename(defaultextension=".json",
                                                filetypes=[("JSON", "*.json")],
                                                parent=root)
        else:
            path = filedialog.askopenfilename(
                filetypes=patterns or [("JSON", "*.json")], parent=root)
        root.destroy()
        return path

    def _dialog_multi(self, patterns):
        """Pick several files at once; returns a list of paths (maybe empty)."""
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        root.update()
        result = filedialog.askopenfilenames(filetypes=patterns, parent=root)
        if isinstance(result, str):             # some Tk builds return one string
            result = root.tk.splitlist(result)
        paths = list(result)
        root.destroy()
        return paths

    def save_layout(self):
        path = self._dialog(save=True)
        if path:
            try:
                with open(path, "w") as fh:
                    json.dump(self.layout_data, fh, indent=2)
                self.notify("Layout saved.")
            except Exception as exc:
                self.notify(f"Save failed: {exc}")

    def load_layout(self):
        path = self._dialog()
        if not path:
            return
        try:
            with open(path, "r") as fh:
                data = json.load(fh)
            cells = [[float(c[0]), float(c[1]), int(c[2])] for c in data]
            if not cells:
                raise ValueError("file contains no tiles")
        except Exception as exc:
            self.notify(f"Could not load layout: {exc}")
            return
        self.layout_data = cells
        self.layout_edited = True
        self.notify("Layout loaded.")

    def save_ts(self):
        path = self._dialog(save=True)
        if path:
            try:
                save_tileset(self.custom_ts, path)
                self.notify("Tileset saved.")
            except Exception as exc:
                self.notify(f"Save failed: {exc}")

    def load_ts(self):
        path = self._dialog()
        if not path:
            return
        try:
            self.custom_ts = load_tileset(path)
            self.scaled_cache.clear()
            self.notify("Tileset loaded.")
        except Exception as exc:
            self.notify(f"Could not load tileset: {exc}")

    def notify(self, message):
        self.notification = message
        self.notification_time = pygame.time.get_ticks()

    # ---------------------------------------------------------- drawing
    def draw(self):
        self.screen.fill((30, 45, 50))
        if self.mode == "menu":
            self.draw_menu()
        elif self.mode == "game":
            self.draw_board()
            self.draw_hud()
        elif self.mode == "editor":
            self.draw_editor()
        elif self.mode == "tileset":
            self.draw_tileset_editor()
        elif self.mode == "music":
            self.draw_music()

        # If the sound device could not be opened, say so once.
        err = self.music.error
        if err and err != self._music_err_seen:
            self._music_err_seen = err
            self.notify("Sound problem: %s" % err)

        for button in self.current_buttons:
            button.draw(self.screen)

        if self.notification and pygame.time.get_ticks() - self.notification_time < 2800:
            self.draw_notification()

        pygame.display.flip()
        self.clock.tick(FPS)

    def draw_hud(self):
        hud = font(26)
        name = "Custom" if self.layout_edited else self.layout_name
        lines = [
            f"Layout: {name}",
            f"Tiles left: {sum(1 for t in self.tiles if t.visible)}",
            f"Matches available: {self.count_moves()}",
            f"Quadruples: {len(self.quad_values)}",
            "F find   U undo   S shuffle   N new",
            "M music on/off   Esc menu",
        ]
        for i, line in enumerate(lines):
            self.screen.blit(hud.render(line, True, (205, 212, 208)), (30, 145 + i * 27))

    def draw_menu(self):
        ty = self.menu_title_y
        title = font(76).render("MAHJONG SOLITAIRE", True, (255, 215, 60))
        self.screen.blit(title, title.get_rect(center=(self.WIDTH // 2, ty)))
        sub = font(30).render("Exact Turtle layout - A-Z, 0-9 alphanumeric tiles",
                              True, (170, 182, 174))
        self.screen.blit(sub, sub.get_rect(center=(self.WIDTH // 2, ty + 52)))

    def draw_board(self):
        ordered = sorted(self.tiles, key=lambda t: (t.z, t.gy, t.gx))
        depth = max(2, int(4 * self.scale))

        # Shadow + face per tile, bottom layer first, so upper-layer shadows
        # land on top of the tiles beneath them.
        for tile in ordered:
            if not tile.visible:
                continue
            rect = self.tile_rect(tile)
            pygame.draw.rect(self.screen, (58, 48, 38),
                             rect.move(depth, depth), border_radius=5)
            pygame.draw.rect(self.screen, (118, 107, 85),
                             rect.move(depth // 2, depth // 2), border_radius=5)
            self.draw_tile(tile)

        if self.won:
            veil = pygame.Surface((self.WIDTH, self.HEIGHT), pygame.SRCALPHA)
            veil.fill((0, 0, 0, 175))
            self.screen.blit(veil, (0, 0))
            text = font(84).render("CLEARED!", True, (255, 215, 60))
            self.screen.blit(text, text.get_rect(center=(self.WIDTH // 2, self.HEIGHT // 2 - 20)))
            tip = font(32).render("Press NEW for another round", True, (220, 226, 222))
            self.screen.blit(tip, tip.get_rect(center=(self.WIDTH // 2, self.HEIGHT // 2 + 46)))

    def draw_tile(self, tile):
        rect = self.tile_rect(tile)
        pygame.draw.rect(self.screen, tile.bg_color, rect, border_radius=5)

        art = tile.custom_surface
        if art is None:
            art = self.default_surfaces.get(tile.kind, {}).get(tile.value, {}).get(tile.color)
        if art is not None:
            pad = max(1, int(2 * self.scale))
            inner = rect.inflate(-2 * pad, -2 * pad)
            if inner.width > 2 and inner.height > 2:
                key = (id(art), inner.width, inner.height)
                scaled = self.scaled_cache.get(key)
                if scaled is None:
                    scaled = pygame.transform.smoothscale(art, (inner.width, inner.height))
                    self.scaled_cache[key] = scaled
                self.screen.blit(scaled, scaled.get_rect(center=rect.center))

        width = max(2, int(tile.border_width * self.scale)) if self.scale < 1 else tile.border_width
        pygame.draw.rect(self.screen, tile.border_color, rect, width, border_radius=5)

    def draw_editor(self):
        for cell in sorted(self.layout_data or [], key=lambda c: (c[2], c[1], c[0])):
            gx, gy, z = cell[0], cell[1], cell[2]
            rect = self.cell_rect(gx, gy, z)
            shade = (152, 156, 158) if z == self.editor_layer else (74, 80, 84)
            pygame.draw.rect(self.screen, shade, rect, border_radius=3)
            pygame.draw.rect(self.screen, (118, 126, 130), rect, 2, border_radius=3)
            tag = font(20).render(str(z), True, (235, 239, 241))
            self.screen.blit(tag, (rect.x + 4, rect.y + 3))

        info = font(28)
        line1 = info.render(
            f"Editing layer {self.editor_layer}   (wheel/UP/DOWN = layer, "
            f"left-click = add, SHIFT = half-step, right-click = remove)",
            True, (255, 215, 60))
        self.screen.blit(line1, (160, 36))
        count = len(self.layout_data or [])
        note = "" if count % 2 == 0 else "   (odd - one tile will be dropped)"
        line2 = info.render(f"{count} tiles placed{note}", True, (200, 206, 204))
        self.screen.blit(line2, (30, 82))

    def draw_tileset_editor(self):
        if self.assign_btn is not None:
            self.assign_btn.text = f"ASSIGN TO {self.sel_value}"

        label = font(24)

        # ---- letter / digit palette
        boxes, lab_l, lab_d, prev_y = self.palette_boxes()
        self.screen.blit(label.render("LETTERS", True, (200, 207, 203)), (30, lab_l))
        self.screen.blit(label.render("DIGITS", True, (200, 207, 203)), (30, lab_d))
        for rect, kind, val in boxes:
            selected = (self.sel_kind == kind and val == self.sel_value)
            assigned = val in self.custom_ts.get(kind, {})
            if selected:
                fill = (255, 209, 51)
            elif assigned:
                fill = (46, 140, 71)
            else:
                fill = (72, 78, 82)
            pygame.draw.rect(self.screen, fill, rect, border_radius=4)
            pygame.draw.rect(self.screen, (130, 138, 141), rect, 1, border_radius=4)
            glyph = label.render(val, True, (30, 33, 34) if selected else (232, 237, 234))
            self.screen.blit(glyph, glyph.get_rect(center=rect.center))

        self.screen.blit(label.render(
            f"Selected: {self.sel_kind} {self.sel_value}", True, (255, 215, 60)),
            (30, prev_y - 24))
        custom = self.custom_ts.get(self.sel_kind, {}).get(self.sel_value)
        if custom is not None and custom.surface is not None:
            self.screen.blit(custom.surface, (30, prev_y))

        # ---- image status line + thumbnail strip
        e = self.cur()
        if e is not None:
            crop_note = "crop set" if e.crop else "no crop - whole image"
            status = (f"Image {self.image_index + 1} of {len(self.images)}: {e.name}"
                      f"   rotation {e.rotation} deg   ({crop_note})")
        else:
            status = f"No images loaded - click ADD IMAGES (up to {MAX_IMAGES} at once)"
        self.screen.blit(label.render(status, True, (220, 226, 222)), (420, 138))

        for rect, idx in self.thumb_rects():
            entry = self.images[idx]
            pygame.draw.rect(self.screen, (50, 58, 62), rect, border_radius=3)
            th = entry.thumb(rect.width - 4)
            self.screen.blit(th, th.get_rect(center=rect.center))
            if idx == self.image_index:
                pygame.draw.rect(self.screen, (255, 215, 60), rect, 3, border_radius=3)
            else:
                pygame.draw.rect(self.screen, (120, 128, 131), rect, 1, border_radius=3)

        # ---- the picture itself
        view = self.tileset_view()
        if view:
            dx, dy, f, dw, dh = view
            key = (id(e), e.rotation, dw, dh)
            if self._shown_key != key:
                self._shown_img = pygame.transform.smoothscale(e.surface(), (dw, dh))
                self._shown_key = key
            self.screen.blit(self._shown_img, (dx, dy))
            if self.drag_start and self.drag_now:
                x0, y0 = self.drag_start
                x1, y1 = self.drag_now
                pygame.draw.rect(self.screen, (255, 215, 60),
                                 Rect(min(x0, x1), min(y0, y1),
                                      abs(x1 - x0), abs(y1 - y0)), 3)
            elif e.crop:
                cx, cy, cw, ch = e.crop
                pygame.draw.rect(self.screen, (255, 215, 60),
                                 Rect(int(dx + cx * f), int(dy + cy * f),
                                      int(cw * f), int(ch * f)), 3)
        else:
            msg = font(30).render(
                "Click ADD IMAGES, then use < > to browse and drag a crop box.",
                True, (190, 198, 195))
            self.screen.blit(msg, (420, 240))

        guide = label.render(
            "1) ADD IMAGES   2) < > to browse   3) [ ] or ROTATE   4) drag a box to crop (optional)"
            "   5) click a letter/digit   6) ASSIGN   7) SAVE",
            True, (170, 182, 174))
        self.screen.blit(guide, (30, self.HEIGHT - 70))

    def draw_notification(self):
        elapsed = pygame.time.get_ticks() - self.notification_time
        alpha = max(0, int(255 * (1 - elapsed / 2800)))
        text = font(34).render(self.notification, True, (255, 221, 97))
        plate = pygame.Surface((text.get_width() + 28, text.get_height() + 14),
                               pygame.SRCALPHA)
        plate.fill((0, 0, 0, min(alpha, 190)))
        rect = plate.get_rect(center=(self.WIDTH // 2, self.HEIGHT - 25))
        self.screen.blit(plate, rect)
        self.screen.blit(text, text.get_rect(center=rect.center))

    # ---------------------------------------------------------- loop
    def run(self):
        while self.running:
            self.handle_events()
            self.process_pending()
            self.draw()
        self.music.stop()
        pygame.quit()


def main():
    try:
        print(f"pygame {pygame.version.ver} / SDL {pygame.version.SDL}")
    except Exception:
        print("Warning: could not read pygame version")
    # The music engine builds its notes in a background thread for the first ~30 seconds. A short
    # thread-switch interval keeps the game smooth while that happens.
    try:
        sys.setswitchinterval(0.0005)
    except Exception:
        pass
    try:
        Game().run()
    except Exception:
        print("=" * 62)
        print("CRASH")
        print("=" * 62)
        traceback.print_exc()
        print("=" * 62)
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror("Mahjong Solitaire crashed", traceback.format_exc())
            root.destroy()
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
