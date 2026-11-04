# The rest of the clone: the real project wiki (private names scrubbed), the
# production brand icon, and the Gmail / Search Console accounts a task can be
# allowed to use.
import json, re, sqlite3, subprocess, time, os
D = '/tmp/demo'
projects = json.load(open(f'{D}/projects.json'))
user = sqlite3.connect(f'{D}/home/state/auth.db').execute('select id from user limit 1').fetchone()[0]
db = sqlite3.connect(f'{D}/home/state/karmax.db')
W = f"{D}/home/content/wiki/project/{projects['tavya']}"
subprocess.run(f"git -C {os.environ['WIKI']} archive HEAD | tar -x -C {W}", shell=True, check=True)
# What must never be shown: the private wiki's ops/launch-video lists it (fetch.py reads the same list).
PRIVATE = [(rf'{t}[-a-z]*', 'acme') for t in json.load(open(f'{D}/prod/private-terms.json'))]
for root, _, files in os.walk(W):
    if '/.git' in root: continue
    for f in files:
        if not f.endswith('.md'): continue
        p = os.path.join(root, f); s = open(p).read(); t = s
        for a, b in PRIVATE: t = re.sub(a, b, t, flags=re.I)
        if t != s: open(p, 'w').write(t)
subprocess.run(['git', '-C', W, 'add', '-A'], check=True)
subprocess.run(['git', '-C', W, '-c', 'user.name=tavya', '-c', 'user.email=tavya@localhost', 'commit', '-qm', 'Project wiki'], check=True)
db.execute("insert or replace into settings (scopeKey, workflow, json) values ('global','appearance',?)", (json.dumps({'icon': 'royal-gold-arrow', 'siteName': 'tavya'}),))
then = int(time.time() * 1000) - 20 * 86400000
for cid, toolkit, label in [('conn_demo_gmail', 'gmail', 'Gmail'), ('conn_demo_gsc', 'google_search_console', 'Google Search Console')]:
    db.execute('insert or replace into kv (k, v) values (?, ?)', (f'service-connection:{cid}', json.dumps({'id': cid, 'organizationId': 'org_personal', 'ownerId': user,
        'toolkit': toolkit, 'label': label, 'projectIds': [], 'status': 'active', 'createdAt': then, 'updatedAt': then, 'accountId': f'ca_{cid}'})))
db.commit()
print('extras: wiki, icon, connections')
