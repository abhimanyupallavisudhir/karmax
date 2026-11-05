# A quiet, warm music bed for the launch video, synthesised so it needs no
# licence: pads, a plucked arpeggio and a soft kick at 112 BPM.
# Usage: python3 music.py <out.wav> <seconds> [marks.json]
import sys, wave, numpy as np

out, seconds = sys.argv[1], float(sys.argv[2])
SR = 48000
n = int(SR * (seconds + 0.5))
t = np.arange(n) / SR
BPM = 112; beat = 60 / BPM; bar = 4 * beat
rng = np.random.default_rng(7)

def note(m):  # MIDI → Hz
    return 440 * 2 ** ((m - 69) / 12)

# Cmaj9 – Am9 – Fmaj9 – G6/9: bright, unresolved, forward-leaning.
CHORDS = [[48, 55, 64, 67, 71, 74], [45, 52, 60, 64, 67, 71], [41, 48, 57, 60, 64, 67], [43, 50, 59, 62, 64, 69]]
L = np.zeros(n); R = np.zeros(n)

def env(length, a, r):
    e = np.ones(length); ai = min(int(a * SR), length); ri = min(int(r * SR), length - ai)
    if ai: e[:ai] = np.linspace(0, 1, ai) ** 2
    if ri: e[-ri:] *= np.linspace(1, 0, ri) ** 1.5
    return e

def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR); y = np.empty_like(x); acc = 0.0
    for i in range(len(x)): acc = (1 - a) * x[i] + a * acc; y[i] = acc
    return y

# Pads: detuned soft saws (few harmonics), one chord per bar.
bars = int(seconds / bar) + 2
for b in range(bars):
    chord = CHORDS[b % 4]; s0 = int(b * bar * SR); length = int(bar * SR * 1.15)
    if s0 >= n: break
    length = min(length, n - s0); tt = np.arange(length) / SR
    sig = np.zeros(length)
    for k, m in enumerate(chord[1:]):
        f = note(m)
        for det in (-0.12, 0.12):
            ff = f * 2 ** (det / 12)
            sig += sum(np.sin(2 * np.pi * ff * h * tt + k) / h ** 1.6 for h in (1, 2, 3))
    sig *= env(length, 0.6, 0.5) * 0.018
    pan = 0.5 + 0.15 * np.sin(b)
    L[s0:s0 + length] += sig * (1 - pan) * 2; R[s0:s0 + length] += sig * pan * 2
    # Bass: the root, round.
    f = note(chord[0] - 12 if chord[0] > 44 else chord[0])
    bass = np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(4 * np.pi * f * tt)
    bass *= env(length, 0.02, 0.3) * 0.05
    L[s0:s0 + length] += bass; R[s0:s0 + length] += bass

# Plucked arpeggio in eighths, entering after the title card.
ARP = [0, 2, 4, 5, 3, 4, 2, 1]
start_arp = 2.6
step = beat / 2
k = 0
s = start_arp
while s < seconds - 1:
    b = int(s / bar); chord = CHORDS[b % 4]
    m = chord[1:][ARP[k % 8] % 5] + 12
    f = note(m); length = int(0.6 * SR); s0 = int(s * SR)
    if s0 + length > n: break
    tt = np.arange(length) / SR
    tone = (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt) + 0.08 * np.sin(6 * np.pi * f * tt)) * np.exp(-tt * 7)
    vel = 0.032 * (1.0 if k % 2 == 0 else 0.7)
    pan = 0.3 if k % 2 else 0.7
    L[s0:s0 + length] += tone * vel * (1 - pan) * 2; R[s0:s0 + length] += tone * vel * pan * 2
    k += 1; s += step

# Soft kick on 1 and 3, hats on the off-beats, from the first full bar after the intro.
s = np.ceil(start_arp / bar) * bar
while s < seconds - 1.5:
    for off, kind in ((0, 'k'), (beat, 'h'), (2 * beat, 'k'), (3 * beat, 'h'), (1.5 * beat, 'h2'), (3.5 * beat, 'h2')):
        s0 = int((s + off) * SR)
        if kind == 'k':
            length = int(0.35 * SR); tt = np.arange(length) / SR
            f = 45 + 70 * np.exp(-tt * 30)
            kick = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9) * 0.16
        else:
            length = int(0.06 * SR); tt = np.arange(length) / SR
            noise = rng.standard_normal(length)
            noise = noise - lowpass(noise, 6000)
            kick = noise * np.exp(-tt * 70) * (0.010 if kind == 'h' else 0.006)
        if s0 + length <= n: L[s0:s0 + length] += kick; R[s0:s0 + length] += kick
    s += bar

# A swell into the finale, a gentle fade at each end.
fade = np.ones(n)
fi = int(0.6 * SR); fo = int(1.2 * SR)
fade[:fi] = np.linspace(0, 1, fi); fade[-fo:] = np.linspace(1, 0, fo) ** 1.4
L *= fade; R *= fade
mix = np.stack([L, R], axis=1)
mix /= np.max(np.abs(mix)) / 0.7  # peak −3 dB: about −16 LUFS, the only sound in the film
pcm = (mix * 32767).astype('<i2')
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(f'music {seconds:.1f}s → {out}')
