# Cuts a take into the video: each mark's speed applies until the next mark
# (0 = cut), frames are retimed onto a 60 fps timeline, then music is laid under.
# Usage: python3 edit.py <take-dir> <out.mp4> [--no-music]
import json, os, subprocess, sys

take, out = sys.argv[1], sys.argv[2]
music = '--no-music' not in sys.argv
frames = sorted(json.load(open(f'{take}/frames.json')), key=lambda f: f['t'])
marks = json.load(open(f'{take}/marks.json'))
start = marks[0]['t']; stop = marks[-1]['t']

PACE = 1.08  # the whole film a touch quicker than life

def speed_at(t):
    s = None
    for m in marks:
        if m['t'] <= t: s = m['speed']
        else: break
    return s and s * PACE

def out_len(a, b):
    """Output seconds that source interval [a, b) takes."""
    total, t = 0.0, a
    bounds = [m['t'] for m in marks if a < m['t'] < b] + [b]
    for nxt in bounds:
        sp = speed_at(t)
        if sp: total += (nxt - t) / sp
        t = nxt
    return total

# Start from the frame showing at `start` (the last one before it), then those after.
before = [f for f in frames if f['t'] < start]
frames = (before[-1:] + [f for f in frames if start <= f['t'] <= stop]) or frames
# The frame showing at `start` is the last one at or before it.
lines, total = [], 0.0
for i, f in enumerate(frames):
    a = f['t'] if i else start
    b = frames[i + 1]['t'] if i + 1 < len(frames) else stop
    d = out_len(a, b)
    if d <= 0: continue
    lines.append(f"file 'frames/{f['f']}'\nduration {d:.5f}")
    total += d
lines.append(f"file 'frames/{frames[-1]['f']}'")
open(f'{take}/concat.txt', 'w').write('\n'.join(lines) + '\n')
print(f'{len(frames)} frames → {total:.1f} s')

silent = out if not music else f'{take}/silent.mp4'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{take}/concat.txt',
                '-vf', 'fps=60,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high',
                '-movflags', '+faststart', silent], check=True)
if music:
    track = f'{take}/music.wav'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'music.py'), track, f'{total:.2f}', f'{take}/marks.json'], check=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', silent, '-i', track, '-map', '0:v', '-map', '1:a',
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], check=True)
# Marks on the output timeline, for review.
acc, prev, rows = 0.0, start, []
for m in marks:
    acc += out_len(prev, m['t']); prev = m['t']; rows.append(f"{acc:7.2f}  {m['name']} ×{m['speed']}")
open(f'{take}/timeline.txt', 'w').write('\n'.join(rows) + '\n')
print(open(f'{take}/timeline.txt').read())
