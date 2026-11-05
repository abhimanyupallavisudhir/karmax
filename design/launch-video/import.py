#!/usr/bin/env python3
"""Clone an organization's projects and tasks (exported from tavya.io) into a scratch
tavya's SQLite store, for the launch video.

    python3 design/launch-video/import.py EXPORT_DIR KARMAX_HOME LOCAL_USER_ID

EXPORT_DIR holds what export.py wrote: projects.json, tasks.json (task summaries per
project), views/<task id>.json (full views: conversation, review info) and
artifacts/<task id>/<index>.<ext> (review files). Private projects and every task that
mentions a private organization are left out (PRIVATE below), with their sub-tasks.
Ids, numbers and times are kept, so links inside conversations still resolve.
Run it while the scratch app is up; hold.sh then keeps unfinished tasks from being
reconciled as "workflow not found".
"""
import glob, hashlib, json, mimetypes, os, sqlite3, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from private import PRIVATE, PRIVATE_PROJECTS  # noqa: E402

export, home, local_user = sys.argv[1], sys.argv[2], sys.argv[3]
projects = [p for p in json.load(open(f'{export}/projects.json')) if p['name'] not in PRIVATE_PROJECTS]
summaries = json.load(open(f'{export}/tasks.json'))
prod_users = set()

def views():
    out = {}
    for f in glob.glob(f'{export}/views/task_*.json'):
        out[os.path.basename(f)[:-5]] = open(f).read()
    return out

raw_views = views()
tasks = [t for p in projects for t in summaries.get(p['id'], [])]
for t in tasks:
    if (t.get('createdBy') or {}).get('kind') == 'user': prod_users.add(t['createdBy']['userId'])

def remap(s: str) -> str:
    for u in prod_users: s = s.replace(u, local_user)
    return s

excluded = {t['id'] for t in tasks if PRIVATE.search(json.dumps(t)) or PRIVATE.search(raw_views.get(t['id'], ''))}
# Sub-tasks of an excluded task go too (their context is the private parent).
changed = True
while changed:
    changed = False
    for t in tasks:
        if t['id'] not in excluded and t.get('parentTaskId') in excluded:
            excluded.add(t['id']); changed = True
kept = [t for t in tasks if t['id'] not in excluded]

db = sqlite3.connect(f'{home}/state/karmax.db', timeout=30)
db.execute('PRAGMA busy_timeout=30000')
with db:
    # The first-run project nobody uses.
    for (pid,) in db.execute("SELECT id FROM projects WHERE name='My project'").fetchall():
        ids = [r[0] for r in db.execute('SELECT id FROM tasks WHERE projectId=?', (pid,))]
        for tid in ids: db.execute('DELETE FROM task_intents WHERE id=?', (tid,))
        db.execute('DELETE FROM tasks WHERE projectId=?', (pid,))
        db.execute('DELETE FROM task_lists WHERE projectId=?', (pid,))
        db.execute('DELETE FROM projects WHERE id=?', (pid,))
    for p in projects:
        db.execute('INSERT OR REPLACE INTO projects (id, organizationId, name, createdAt, config, ord, folder) VALUES (?,?,?,?,?,?,?)',
                   (p['id'], 'org_personal', p['name'], p['createdAt'], json.dumps(p.get('config') or {}), p.get('order', 0), p.get('folder')))
    lists = {}
    for t in kept: lists.setdefault(t['listId'], t['projectId'])
    for lid, pid in lists.items():
        db.execute('INSERT OR REPLACE INTO task_lists (id, projectId, name, createdAt, ord) VALUES (?,?,?,?,0)', (lid, pid, 'Tasks', 0))
    n_conv = 0
    for t in kept:
        view = json.loads(remap(raw_views[t['id']])) if t['id'] in raw_views else None
        last = view or t.get('lastView')
        conversation = None
        if last is not None:
            last = dict(last)
            messages, transcripts = last.pop('messages', None), last.pop('transcripts', None)
            if messages is not None or transcripts is not None:
                conversation = json.dumps({'messages': messages or [], 'transcripts': transcripts or []}); n_conv += 1
            for k in ('subTaskSummaries', 'forkSummaries', 'forkSourceSummaries', 'parentTask', 'notes', 'acceptedAction', 'num'):
                last.pop(k, None)
        created_by = json.loads(remap(json.dumps(t.get('createdBy')))) if t.get('createdBy') else None
        db.execute('''INSERT OR REPLACE INTO tasks (id, num, projectId, listId, title, workflow, executionWorkflow, workflowVersion,
            params, createdAt, ord, parentTaskId, lastView, statusChangedAt, createdBy, conversation, intentId, attemptNumber)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (t['id'], t.get('num'), t['projectId'], t['listId'], t['title'], t['workflow'], t.get('executionWorkflow') or t['workflow'],
             t.get('workflowVersion') or '1.0.0', remap(json.dumps(t.get('params') or {})), t['createdAt'], t.get('order', 0),
             t.get('parentTaskId'), json.dumps(last) if last is not None else None, t.get('statusChangedAt'),
             json.dumps(created_by) if created_by else None, conversation, t.get('intentId') or t['id'], t.get('attemptNumber') or 1))
        # The list holds each logical task's principal attempt; its intent row may name a root the export lacks.
        intent = t.get('intentId') or t['id']
        db.execute('INSERT OR REPLACE INTO task_intents (id, principalAttemptId, createdAt) VALUES (?,?,?)', (intent, t['id'], t['createdAt']))
    # Review files: the same index preserveReviewArtifacts writes (src/store/review-artifacts.ts).
    n_art = 0
    kept_ids = {t['id']: t for t in kept}
    for d in glob.glob(f'{export}/artifacts/task_*'):
        tid = os.path.basename(d)
        if tid not in kept_ids or tid not in raw_views: continue
        actions = (json.loads(raw_views[tid]).get('reviewInfo') or {}).get('actions') or []
        index = json.loads((db.execute('SELECT v FROM kv WHERE k=?', (f'review-artifacts:{tid}',)).fetchone() or ['{}'])[0])
        for f in glob.glob(f'{d}/*'):
            i = int(os.path.basename(f).split('.')[0])
            target = actions[i]['target']
            data = open(f, 'rb').read()
            sha = hashlib.sha256(data).hexdigest()
            aid = 'review-' + hashlib.sha256(f'{tid}\0{target}\0{sha}'.encode()).hexdigest()
            key = f"artifacts/org_personal/{kept_ids[tid]['projectId']}/{tid}/{aid}/demo"
            os.makedirs(os.path.dirname(f'{home}/objects/{key}'), exist_ok=True)
            open(f'{home}/objects/{key}', 'wb').write(data)
            name = os.path.basename(target)
            mt = mimetypes.guess_type(name)[0] or 'application/octet-stream'
            db.execute('INSERT OR REPLACE INTO promoted_artifacts (id, organizationId, projectId, taskId, objectKey, sha256, bytes, mediaType, name, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
                       (aid, 'org_personal', kept_ids[tid]['projectId'], tid, key, sha, len(data), mt, name, int(time.time() * 1000)))
            index[hashlib.sha256(target.encode()).hexdigest()] = aid
            n_art += 1
        db.execute('INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)', (f'review-artifacts:{tid}', json.dumps(index)))
# Activity (tool calls, pushes, PRs) of the tasks the video opens: events/<task id>.json.
n_ev = 0
with db:
    for f in glob.glob(f'{export}/events/task_*.json'):
        tid = os.path.basename(f)[:-5]
        if tid not in kept_ids: continue
        db.execute('DELETE FROM events WHERE taskId=?', (tid,))
        for e in json.load(open(f)):
            payload = remap(json.dumps(e.get('payload') or {}))
            if PRIVATE.search(payload): continue
            db.execute('INSERT OR REPLACE INTO events (seq, taskId, type, ts, payload) VALUES (?,?,?,?,?)', (e['seq'], tid, e['type'], e['ts'], payload))
            n_ev += 1
print(json.dumps({'projects': len(projects), 'tasks': len(kept), 'excluded': len(excluded), 'conversations': n_conv, 'artifacts': n_art, 'events': n_ev}))
unfinished = [t['id'] for t in kept if (t.get('lastView') or {}).get('status') not in (None, 'done', 'cancelled', 'failed') and not (t.get('params') or {}).get('draft')]
open(f'{export}/unfinished.txt', 'w').write('\n'.join(unfinished) + '\n')
