# The portrait (4:5, 1080×1350) cut of a film, for phones: the picture is cropped
# to the square around the action (followed from the stage's log: the camera's
# focus when zoomed, else the cursor), so its text is ~1.8× larger than in the
# landscape film on the same screen; full-stage moments (title card, terminal,
# grid) are shown whole. Captions are set large in their own band below.
# Usage: python3 mobile.py <cut.mp4> <out.mp4>   (reads <cut.mp4>.json; audio from <cut.mp4>)
import bisect, html, json, math, os, re, subprocess, sys
from concurrent.futures import ProcessPoolExecutor
from PIL import Image

cut, out = sys.argv[1], sys.argv[2]
meta = json.load(open(cut + '.json'))
take = meta['take']
log = json.load(open(os.path.join(take, 'stage-log.json')))
track = sorted(log['track'], key=lambda s: s['t'])
tt = [s['t'] for s in track]
Z = 4 / 3                      # stage px → frame px
W, H = 1080, 1350              # output
PIC = 1080                     # picture box (square, top)
CROP = 976                     # source square: everything above the caption band
FULL = (0, 0, 1920, 976)       # a full-stage moment, without the burnt-in caption band
BG = (238, 240, 245)
frames = meta['frames']


def sample(t):
    i = bisect.bisect_right(tt, t) - 1
    return track[max(0, min(i, len(track) - 1))]


# Follow the action smoothly in film time: x eases towards its target (~0.35 s),
# and the switch between crop and whole stage eases over ~0.45 s.
rects, x_s, k_s, prev_at = [], None, None, None
for fr in frames:
    s = sample(fr['src'])
    x = min(max(s['x'] * Z, CROP / 2), 1920 - CROP / 2)
    k = 1.0 if s['full'] else 0.0
    if x_s is None: x_s, k_s = x, k
    else:
        dt = max(0.0, fr['at'] - prev_at)
        x_s += (x - x_s) * (1 - math.exp(-dt / 0.35))
        k_s += (k - k_s) * (1 - math.exp(-dt / 0.15)) if abs(k - k_s) > 0.002 else 0
        k_s = min(1.0, max(0.0, k_s))
    prev_at = fr['at']
    e = k_s * k_s * (3 - 2 * k_s)  # smoothstep
    crop = (x_s - CROP / 2, 0, CROP, CROP)
    rects.append(tuple(c + (f - c) * e for c, f in zip(crop, FULL)))

src_dir = os.path.join(take, 'frames')
dst_dir = os.path.join(take, 'mobile-frames' + ('-readable' if meta['readable'] else ''))
os.makedirs(dst_dir, exist_ok=True)


def render(job):
    i, name, (x, y, w, h) = job
    im = Image.open(os.path.join(src_dir, name)).convert('RGB')
    scale = PIC / w
    pic = im.crop((round(x), round(y), round(x + w), round(y + h))).resize((PIC, round(h * scale)), Image.LANCZOS)
    canvas = Image.new('RGB', (W, H), BG)
    canvas.paste(pic, (0, (PIC - pic.height) // 2))
    canvas.save(os.path.join(dst_dir, f'{i:07d}.jpg'), quality=92)


with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) - 1)) as pool:
    list(pool.map(render, [(i, fr['f'], r) for i, (fr, r) in enumerate(zip(frames, rects))], chunksize=40))

concat = os.path.join(take, 'mobile-concat.txt')
with open(concat, 'w') as f:
    for i, fr in enumerate(frames): f.write(f"file '{dst_dir}/{i:07d}.jpg'\nduration {fr['dur']:.5f}\n")
    f.write(f"file '{dst_dir}/{len(frames) - 1:07d}.jpg'\n")

# Captions in film time: a take time maps through the frame that shows it.
srcs = [fr['src'] for fr in frames]
def film_time(t):
    i = max(0, bisect.bisect_right(srcs, t) - 1)
    fr = frames[i]
    nxt = frames[i + 1]['src'] if i + 1 < len(frames) else meta['stop']
    span = max(1e-6, nxt - fr['src'])
    return fr['at'] + min(1.0, max(0.0, (t - fr['src']) / span)) * fr['dur']

def ass_text(h):
    h = re.sub(r'(<kbd>[^<]*</kbd>)+', lambda m: ''.join(re.findall(r'<kbd>([^<]*)</kbd>', m.group(0))), h)
    h = re.sub(r'<em>(.*?)</em>', r'{\\c&HD65B5B&}\1{\\c&H1D1616&}', h)
    return html.unescape(re.sub(r'<[^>]+>', '', h)).replace('\n', ' ')

def stamp(s):
    s = max(0.0, s); return f'{int(s // 3600)}:{int(s % 3600 // 60):02d}:{s % 60:05.2f}'

caps = sorted(log['captions'], key=lambda c: c['t'])
events = []
for i, c in enumerate(caps):
    if not c['html']: continue
    a = film_time(c['t']); b = film_time(caps[i + 1]['t']) if i + 1 < len(caps) else meta['total']
    if b - a > 0.15: events.append(f"Dialogue: 0,{stamp(a + 0.05)},{stamp(b)},Cap,,0,0,0,,{{\\fad(180,150)}}{ass_text(c['html'])}")
ass = os.path.join(take, 'mobile' + ('-readable' if meta['readable'] else '') + '.ass')
open(ass, 'w').write(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter,54,&H001D1616,&H001D1616,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,-0.5,0,1,0,0,5,70,70,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(e.replace(',Cap,,0,0,0,,', f',Cap,,0,0,0,,{{\\pos({W // 2},{PIC + (H - PIC) // 2})}}') for e in events) + '\n')

subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-i', cut,
                '-vf', f'fps=60,ass={ass},format=yuv420p', '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'slow',
                '-crf', '18', '-profile:v', 'high', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out], check=True)
print('→', out)
