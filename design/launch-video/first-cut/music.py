#!/usr/bin/env python3
"""The launch video's score, synthesized (no samples, nothing licensed).

    python3 design/launch-video/first-cut/music.py out.wav CUTS CLICKS DURATION

CUTS and CLICKS are comma-separated times in seconds (scene starts, cursor clicks):
a soft swell leads into each cut, a tick marks each click. 112 BPM, D major,
Dmaj9 – Bm9 – Gmaj9 – A6sus, pad + plucked arpeggio + a light kick and hats.
"""
import sys
import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000
out, cuts, clicks, duration = sys.argv[1], [float(x) for x in sys.argv[2].split(',') if x], \
    [float(x) for x in sys.argv[3].split(',') if x], float(sys.argv[4])
N = int(SR * (duration + 0.5))
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)
BPM = 112; BEAT = 60 / BPM; BAR = 4 * BEAT
midi = lambda m: 440 * 2 ** ((m - 69) / 12)
lp = lambda x, f, o=2: sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
hp = lambda x, f, o=2: sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)

def add(sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N: return
    sig = sig[: N - i]
    L[i:i + len(sig)] += sig * gain * (1 - max(pan, 0))
    R[i:i + len(sig)] += sig * gain * (1 + min(pan, 0))

def env(n, a, r, sustain=1.0):
    e = np.ones(n) * sustain
    na, nr = int(a * SR), int(r * SR)
    e[:na] = np.linspace(0, sustain, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e

# Chords (MIDI): voicings kept close and warm.
CHORDS = [[50, 57, 61, 64, 66, 69], [47, 54, 57, 61, 62, 66], [43, 50, 54, 57, 59, 62], [45, 52, 54, 57, 59, 64]]
ROOTS = [38, 35, 31, 33]

def saw(f, n, detune):
    """Band-limited (additive) detuned saw: harmonics 1/h up to 6 kHz, no aliasing."""
    t = np.arange(n) / SR
    x = np.zeros(n)
    for d in (-detune, 0, detune):
        ff = f * (1 + d)
        for h in range(1, int(6000 // ff) + 1):
            x += np.sin(2 * np.pi * ff * h * t + h * 0.37) / h
    return x / 3

# Pad: two bars per chord, from 0.4 s to the end.
t = 0.0; ci = 0
while t < duration:
    n = int(2 * BAR * SR) + int(0.8 * SR)
    chord = CHORDS[ci % 4]
    for k, m in enumerate(chord):
        for side, det in ((-0.6, 0.0035), (0.6, 0.0045)):
            x = lp(saw(midi(m), n, det), 900 + 500 * (k / len(chord)), 4)
            add(x * env(n, 0.9, 0.9, 1.0), t, 0.030, side)
    sub = np.sin(2 * np.pi * midi(ROOTS[ci % 4]) * np.arange(n) / SR)
    add(sub * env(n, 0.5, 0.8), t, 0.10)
    t += 2 * BAR; ci += 1

# Plucked arpeggio from the first statement on (8ths), brighter later.
def pluck(f, n=int(0.6 * SR), bright=0.5):
    tt = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * h * tt) / h ** (1.6 - bright) for h in (1, 2, 3, 4))
    return x * np.exp(-tt * 7) * env(n, 0.004, 0.08)
ARP = [0, 2, 3, 5, 4, 2, 3, 1]
start = cuts[1] if len(cuts) > 1 else 3.0
k = 0; t = start
while t < duration - 3.5:
    ci = int(t // (2 * BAR)) % 4
    chord = CHORDS[ci]
    note = chord[ARP[k % 8] % len(chord)] + 12
    bright = min(1.0, 0.3 + t / duration)
    add(pluck(midi(note), bright=bright), t, 0.07, 0.35 if k % 2 else -0.35)
    t += BEAT / 2; k += 1

# Kick on 1 and 3, hats on the off-beats, between the third cut and the end card.
def kick():
    n = int(0.35 * SR); tt = np.arange(n) / SR
    f = 52 + 90 * np.exp(-tt * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9)
def hat():
    n = int(0.06 * SR)
    return hp(rng.standard_normal(n), 7000) * np.exp(-np.arange(n) / SR * 70)
k_from = cuts[2] if len(cuts) > 2 else 11.0
h_from = cuts[3] if len(cuts) > 3 else 18.0
end_card = cuts[-1] if cuts else duration - 4
b = 0; t = 0.0
while t < end_card:
    if t >= k_from and b % 2 == 0: add(kick(), t, 0.42)
    if t >= h_from: add(hat(), t + BEAT / 2, 0.05, 0.2)
    t += BEAT; b += 1

# Swell into each cut; a tick on each click.
for c in cuts[1:]:
    n = int(0.6 * SR)
    noise = lp(hp(rng.standard_normal(n), 900), 5000)
    add(noise * np.linspace(0, 1, n) ** 2.2, c - 0.6, 0.035)
for c in clicks:
    n = int(0.05 * SR); tt = np.arange(n) / SR
    add(np.sin(2 * np.pi * 2200 * tt) * np.exp(-tt * 140), c, 0.12)

# End: the tonic chord rings out over the end card.
n = int(4.5 * SR)
for m in [50, 57, 62, 66, 69, 74]:
    tt = np.arange(n) / SR
    add(np.sin(2 * np.pi * midi(m) * tt) * np.exp(-tt * 0.8) * env(n, 0.02, 1.0), end_card, 0.05)

mix = np.stack([L, R], 1)[: int(SR * duration)]
fade = int(1.6 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
mix[: int(0.3 * SR)] *= np.linspace(0, 1, int(0.3 * SR))[:, None]
mix = np.tanh(mix / (np.abs(mix).max() + 1e-9) * 1.6) * 0.72
import wave
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('wrote', out, f'{duration:.2f}s')
