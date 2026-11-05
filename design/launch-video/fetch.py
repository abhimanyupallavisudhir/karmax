# Snapshots what the demo clones from tavya.io: the personal organization's
# projects and task lists (minus everything private), the real review artifacts
# of the tasks the video re-enacts, and the photos for the CLI scene.
# Run inside a tavya task (KARMAX_GATEWAY_URL and KARMAX_TOKEN set) or with a
# personal token. Writes $DEMO_DIR/prod and $DEMO_DIR/assets.
import json, os, re, sys, urllib.parse, urllib.request

D = os.environ.get('DEMO_DIR', '/tmp/demo')
B, T = os.environ['KARMAX_GATEWAY_URL'], os.environ['KARMAX_TOKEN']
HERE = os.path.dirname(os.path.abspath(__file__))
WIKI = os.environ.get('KARMAX_WIKI') or next((os.path.join(HERE, '../../..', d) for d in os.listdir(os.path.join(HERE, '../../..')) if d.startswith('krmax-wiki-')), None)
os.makedirs(f'{D}/prod', exist_ok=True); os.makedirs(f'{D}/assets', exist_ok=True)

def get(p, raw=False, method='GET', body=None):
    req = urllib.request.Request(B + p, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + T, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read() if raw else json.load(r)

# What must never be shown lives in the private wiki (ops/launch-video), not in this public repository.
sys.path.insert(0, HERE)
from private import PRIVATE, PRIVATE_PROJECTS, TERMS  # noqa: E402
json.dump(TERMS, open(f'{D}/prod/private-terms.json', 'w'))
# Also: links to other organizations, e-mail addresses, people's surnames.
OTHER = re.compile(r'tavya\.io/(?!personal|api|mcp|cli|docs|pricing|policies)[a-z0-9-]+|@[a-z0-9.-]+\.(com|org|io)|sudhir', re.I)
SKIP = {'S3 storage integration tests', 'Fork contributions E2E'}

projects = [p for p in get('/api/projects') if p['organizationId'] == 'org_personal' and p['name'] not in SKIP and p['name'] not in PRIVATE_PROJECTS and not PRIVATE.search(p['name'])]
json.dump(projects, open(f'{D}/prod/projects.json', 'w'), indent=1)
for p in projects:
    out, lo = [], 0
    while True:
        d = get(f"/api/projects/{p['id']}/search?q={urllib.parse.quote(f'num:>={lo} num:<{lo + 150}')}")
        for t in d['tasks']:
            prompt = (t.get('params') or {}).get('prompt', '')
            if PRIVATE.search(json.dumps({k: t.get(k) for k in ('title', 'params')})) or OTHER.search(f"{t['title']}\n{prompt}"): continue
            lv = t.get('lastView') or {}
            out.append({'num': t['num'], 'title': t['title'], 'workflow': t['workflow'], 'createdAt': t['createdAt'],
                        'statusChangedAt': t.get('statusChangedAt'), 'stage': lv.get('stage'), 'status': lv.get('status'),
                        'prompt': (t.get('params') or {}).get('prompt', '')[:4000], 'parentTaskId': t.get('parentTaskId'), 'id': t['id']})
        if not d['tasks'] and lo > max([x['num'] for x in out] + [0]): break
        lo += 150
    out.sort(key=lambda t: t['num'])
    json.dump(out, open(f"{D}/prod/tasks-{p['name']}.json", 'w'), indent=0)
    print(p['name'], len(out))

# The real runs the video re-enacts (tavya #815 usability overhaul, #821 SEO, #822 release trigger).
TAVYA = next(p['id'] for p in projects if p['name'] == 'tavya')
def find(num): return get(f"/api/projects/{TAVYA}/search?q={urllib.parse.quote(f'num:{num}')}")['tasks'][0]['id']
def artifact(task_id, index, to):
    url = get(f'/api/tasks/{task_id}/review-action', method='POST', body={'index': index})['url']
    open(to, 'wb').write(get(url, raw=True))
os.makedirs(f'{D}/assets/815', exist_ok=True); os.makedirs(f'{D}/assets/seo', exist_ok=True); os.makedirs(f'{D}/assets/822', exist_ok=True)
t815 = find(815)
open(f'{D}/assets/815-prompt.md', 'w').write(get(f'/api/tasks/{t815}')['messages'][0]['text'])
for i in range(8): artifact(t815, i, f'{D}/assets/815/{i}.png')
artifact(find(821), 0, f'{D}/assets/seo/social-card.png')
artifact(find(822), 1, f'{D}/assets/822/runbook.md')
os.makedirs(f'{D}/assets/deploy', exist_ok=True)
open(f'{D}/assets/deploy/deploy.yml', 'w').write(open(os.path.join(HERE, '../../.github/workflows/deploy.yml')).read())

# Photos (Unsplash, via Picsum) under the names the album manifest expects.
manifest = json.load(open(os.path.join(HERE, 'assets/photos.json')))
os.makedirs(f'{D}/photos-original', exist_ok=True)
for ph in manifest['photos']:
    dest = f"{D}/photos-original/{ph['file']}"
    if not os.path.exists(dest):
        urllib.request.urlretrieve(f"https://picsum.photos/id/{ph['picsum']}/1600/1067", dest)
for dup in manifest['duplicates']:
    open(f"{D}/photos-original/{dup['file']}", 'wb').write(open(f"{D}/photos-original/{dup['copyOf']}", 'rb').read())
json.dump({ph['file']: ph['album'] for ph in manifest['photos']}, open(f'{D}/photo-albums.json', 'w'), indent=1)
print('assets ready')
