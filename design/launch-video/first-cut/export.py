#!/usr/bin/env python3
"""Export an organization from tavya.io for the launch-video clone (read-only).

    KARMAX_TOKEN=… python3 design/launch-video/first-cut/export.py EXPORT_DIR

Writes projects.json, tasks.json (every task summary per project), views/<task id>.json
(full views: conversation and Review info) for recent and unfinished tasks,
artifacts/<task id>/<action index>.<ext> (saved Review files) and events/<task id>.json
(tool-call activity) for the tasks the video opens (HEROES). Keep EXPORT_DIR out of
git: it is the organization's real data. import.py leaves out what is private.
"""
import json, os, sys, urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # ../private.py
from private import PRIVATE, PRIVATE_PROJECTS  # noqa: E402

T = os.environ['KARMAX_TOKEN']
B = os.environ.get('KARMAX_GATEWAY_URL', 'https://tavya.io')
UA = 'tavya-demo-export/1.0'  # the artifact CDN refuses Python's default agent
out = sys.argv[1]
HEROES = {('personal-website', 5), ('legibench3', 19), ('legibench3', 20), ('lvpm', 8), ('tavya', 832), ('tavya', 822),
          ('tavya', 367), ('tavya', 836), ('solib', 5), ('takehomev2', 28), ('legibench3', 23), ('tavya', 838)}
EXT = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.md', '.html', '.csv', '.svg', '.mp4', '.webm', '.txt')

def call(method, path, body=None, auth=True):
    url = path if path.startswith('http') else B + path
    headers = {'User-Agent': UA, 'content-type': 'application/json'}
    if auth and not url.startswith('https://tavya-review'): headers['Authorization'] = 'Bearer ' + T
    req = urllib.request.Request(url, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    return urllib.request.urlopen(req, timeout=300).read()

def get(path): return json.loads(call('GET', path))

for d in ('views', 'artifacts', 'events'): os.makedirs(f'{out}/{d}', exist_ok=True)
projects = [p for p in get('/api/projects') if p['name'] not in PRIVATE_PROJECTS]
json.dump(projects, open(f'{out}/projects.json', 'w'))
tasks = {}
for p in projects:
    rows, offset = [], 0
    while True:
        page = get(f"/api/projects/{p['id']}/tasks?page=1&limit=200&offset={offset}&includeArchived=1")
        rows += page['tasks']; offset += 200
        if offset >= page.get('total', 0): break
    tasks[p['id']] = rows
json.dump(tasks, open(f'{out}/tasks.json', 'w'))
names = {p['id']: p['name'] for p in projects}
wanted = []
for pid, rows in tasks.items():
    recent = sorted(rows, key=lambda t: -t['createdAt'])[:70]
    for t in rows:
        if t['params'].get('draft') or PRIVATE.search(json.dumps(t)): continue
        if names[pid] != 'tavya' or not t['params'].get('archived') or t in recent or (names[pid], t.get('num')) in HEROES:
            wanted.append((names[pid], t))
for name, t in wanted:
    f = f"{out}/views/{t['id']}.json"
    if not os.path.exists(f):
        try:
            view = get(f"/api/tasks/{t['id']}")
            if view: json.dump(view, open(f, 'w'))
        except Exception as e: print('view', t['id'], e, file=sys.stderr); continue
    if not os.path.exists(f): continue
    view = json.load(open(f))
    for i, a in enumerate((view.get('reviewInfo') or {}).get('actions') or []):
        target = a.get('target', '')
        if a.get('kind') != 'open' or target.startswith('http') or not target.lower().endswith(EXT): continue
        dest = f"{out}/artifacts/{t['id']}/{i}{os.path.splitext(target)[1]}"
        if os.path.exists(dest): continue
        try:
            link = json.loads(call('POST', f"/api/tasks/{t['id']}/review-action", {'index': i}))
            if link.get('bytes', 0) > 40e6: continue
            data = call('GET', link['url'])
            os.makedirs(os.path.dirname(dest), exist_ok=True); open(dest, 'wb').write(data)
        except Exception as e: print('artifact', t['id'], target, e, file=sys.stderr)
    if (name, t.get('num')) in HEROES:
        json.dump(get(f"/api/tasks/{t['id']}/events?since=0&limit=5000"), open(f"{out}/events/{t['id']}.json", 'w'))
print(json.dumps({'projects': len(projects), 'tasks': sum(map(len, tasks.values())), 'views': len(wanted)}))
