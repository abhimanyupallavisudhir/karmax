# Lays a voiceover over a cut: one line per scene, spoken by OpenAI's TTS
# (OPENAI_API_KEY), each starting at its scene's mark (or after the line before),
# with the music ducked under the voice. Lines are cached by text, so a re-cut
# costs nothing.
# Usage: python3 voice.py <cut.mp4> <out.mp4>      (reads <cut.mp4>.json from edit.py)
import hashlib, json, os, subprocess, sys, urllib.request, wave
import numpy as np

cut, out = sys.argv[1], sys.argv[2]
meta = json.load(open(cut + '.json'))
take = meta['take']
CACHE = os.environ.get('VO_CACHE', '/tmp/demo/vo-cache')
VOICE = os.environ.get('VO_VOICE', 'coral')
MODEL = 'gpt-4o-mini-tts'
STYLE = ('A warm, confident product-launch narrator: clear, unhurried, a smile in the voice, never salesy. '
         'Say "tavya" as "TUV-yuh" (rhymes with "of ya"). Say "MCP" as letters, "CLI" as letters.')

# (mark, offset seconds, line). A line starts at its mark + offset, or after the previous line.
LINES = [
    ('intro', 0.4, 'tavya. The agentic to-do list that completes itself.'),
    ('rapid-typing', 0.6, 'Write a task, hit command-enter, and write the next one. '
                          'A usability overhaul. Buy a domain, on a twenty-five dollar budget. Update my CV. Fix our SEO.'),
    ('rapid-done', 0.1, 'Each one runs on its own computer, in parallel.'),
    ('domain-work', 0.2, 'The domain task signs up, pays from your card within its budget, '
                         'saves the new login to your vault, and sets up deploys. You read the summary, and confirm.'),
    ('seo-open', 0.2, 'When an agent needs an account, it asks. You click Allow.'),
    ('cv-params', 0.2, 'Review the work yourself, or remove the reviewer, and it ships on its own.'),
    ('seo-review', 0.3, 'Or hand the review to another AI, with your own instructions.'),
    ('overhaul', 0.2, 'Big changes come with proof you can check, right in Review.'),
    ('trigger', 0.2, 'Tasks can start themselves: on a schedule, on an event, or after another task. '
                     "Here an agent uses tavya's own MCP to keep tavya current with every new Claude Code and Codex."),
    ('cli', 0.3, "And it's not just for code. Push a folder of photos from your laptop, ask for them sorted, "
                 'and pull back the albums.'),
    ('flight', 0.2, 'Or let it run your life. Book the cheapest direct flight to London, on a five-hundred dollar budget. '
                    'It asks before it uses your United login, then books it.'),
    ('wiki', 0.2, 'What agents learn, they write down, in a wiki you can read.'),
    ('grid', 0.1, 'Plus every major coding agent, a computer per task, a vault, any app, sub-tasks, and insights.'),
    ('finale', 0.2, 'And one more task: make a launch video. Two hours and forty minutes later…'),
    ('finale-zoom', 0.3, 'tavya.'),
]
SR = 24000  # OpenAI's wav


def speak(text):
    key = hashlib.sha256(f'{MODEL}|{VOICE}|{STYLE}|{text}'.encode()).hexdigest()[:20]
    path = os.path.join(CACHE, f'{key}.wav')
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        req = urllib.request.Request('https://api.openai.com/v1/audio/speech', method='POST',
            headers={'Authorization': f"Bearer {os.environ['OPENAI_API_KEY']}", 'Content-Type': 'application/json'},
            data=json.dumps({'model': MODEL, 'voice': VOICE, 'input': text, 'instructions': STYLE, 'response_format': 'wav'}).encode())
        with urllib.request.urlopen(req, timeout=120) as r: data = r.read()
        open(path, 'wb').write(data)
    # OpenAI's streamed wav header carries no length; read the PCM after it.
    raw = open(path, 'rb').read()
    pcm = raw[raw.index(b'data') + 8:]
    a = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype='<i2').astype(np.float32) / 32768
    nz = np.flatnonzero(np.abs(a) > 0.01)  # trim silence at the ends
    return a[max(0, nz[0] - 600): nz[-1] + 1200] if len(nz) else a


marks = {m['name']: m['at'] for m in meta['marks']}
total = meta['total']
track = np.zeros(int(SR * total), dtype=np.float32)
cursor, report = 0.0, []
for name, offset, text in LINES:
    if name not in marks: continue
    a = speak(text)
    start = max(marks[name] + offset, cursor + 0.25)
    end = start + len(a) / SR
    if end > total - 0.3:  # never past the end: speed the last words up a little
        rate = min(1.25, (len(a) / SR) / max(0.5, total - 0.3 - start))
        a = np.interp(np.arange(0, len(a), rate), np.arange(len(a)), a).astype(np.float32)
        end = start + len(a) / SR
    i = int(start * SR); track[i:i + len(a)] += a[: len(track) - i]
    report.append(f'{start:7.2f}–{end:7.2f}  {name:13s} {"(late %.1fs)" % (start - marks[name] - offset) if start > marks[name] + offset + 0.05 else ""}')
    cursor = end
print('\n'.join(report))
vo = f'{out}.vo.wav'
with wave.open(vo, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(track, -1, 1) * 32767).astype('<i2').tobytes())
music = os.path.join(take, 'music.wav')
# Music under the voice: ducked by a sidechain on the voice, then both levelled.
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', cut, '-i', music, '-i', vo, '-filter_complex',
                f'[2:a]aresample=48000,asplit=2[v1][v2];[1:a]volume=0.8[m];'
                '[m][v1]sidechaincompress=threshold=0.015:ratio=12:attack=25:release=450:makeup=1[duck];'
                f'[duck][v2]amix=inputs=2:normalize=0:weights=1 1.15,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000,atrim=0:{total:.3f}[a]',
                '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', f'{total:.3f}',
                '-movflags', '+faststart', out], check=True)
json.dump({**meta, 'video': out}, open(out + '.json', 'w'))
print('→', out)
