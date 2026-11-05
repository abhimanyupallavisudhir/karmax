#!/usr/bin/env python3
"""Put imported tasks of the demo clone into the moment the video shows them in.

    python3 -I design/launch-video/first-cut/stage.py KARMAX_HOME <scene> [<scene>…]

A task's view is its real one; a scene only rewinds where it stood (a merged pull
request back to Review, a finished turn back to Working). Every task a scene leaves
unfinished needs a hold (hold.sh), or the reconciler marks it failed.
"""
import json, sqlite3, subprocess, sys, os

home = sys.argv[1]
db = sqlite3.connect(f'{home}/state/karmax.db', timeout=30)
TEMPORAL = os.environ.get('TEMPORAL_CLI', os.path.expanduser('~/.temporalio/bin/temporal'))

def task(project, num):
    row = db.execute('SELECT t.id, t.lastView, t.params FROM tasks t JOIN projects p ON p.id=t.projectId WHERE p.name=? AND t.num=?',
                     (project, num)).fetchone()
    if not row: raise SystemExit(f'no task {project}#{num}')
    return row[0], json.loads(row[1] or '{}'), json.loads(row[2] or '{}')

def hold(tid):
    subprocess.run([TEMPORAL, 'workflow', 'start', '--address', '127.0.0.1:7233', '--task-queue', 'demo-hold',
                    '--type', 'demoHold', '--workflow-id', tid], capture_output=True)

def save(tid, view, params):
    params.pop('archived', None)
    with db:
        db.execute('UPDATE tasks SET lastView=?, params=?, statusChangedAt=strftime("%s","now")*1000 WHERE id=?',
                   (json.dumps(view), json.dumps(params), tid))
    if view.get('status') not in ('done', 'cancelled', 'failed'): hold(tid)

def in_review(project, num):
    tid, v, p = task(project, num)
    files = len((v.get('reviewInfo') or {}).get('changedFiles') or [])
    v.update(stage='review', status='waiting', waitingFor={'kind': 'human', 'audience': ['@creator']})
    v['state'] = {**v.get('state', {}), 'confirmed': False}
    v['reviewInfo'] = {**(v.get('reviewInfo') or {}), 'summary': f'{files} file(s) changed.' if files else ''}
    for pr in [v.get('pr'), *(v.get('prs') or [])]:
        if pr: pr.update(state='open', merged=False)
    v.pop('landing', None)
    v['actions'] = [{'name': 'confirm', 'kind': 'signal', 'label': 'Confirm PR', 'enabled': True},
                    {'name': 'followUp', 'kind': 'signal', 'label': 'Send follow-up', 'enabled': True,
                     'args': [{'name': 'text', 'type': 'text', 'label': 'Message', 'required': True}]},
                    {'name': 'cancel', 'kind': 'signal', 'label': 'Cancel', 'enabled': True, 'danger': True}]
    save(tid, v, p)

def merged(project, num):
    """Back to what the import holds (the real, final view)."""
    tid, v, p = task(project, num)
    v.update(stage='done', status='done'); v.pop('waitingFor', None)
    for pr in [v.get('pr'), *(v.get('prs') or [])]:
        if pr: pr.update(state='closed', merged=True)
    save(tid, v, p)

def working(project, num, fresh=False):
    tid, v, p = task(project, num)
    v.update(stage='do', status='active'); v.pop('waitingFor', None)
    v['agentTurn'] = {'turnId': f'{tid}:demo#1', 'role': 'do', 'provider': (v.get('agents') or {}).get('do', {}).get('provider', 'claude'), 'state': 'running'}
    if fresh:  # mid first turn: nothing proposed yet
        for k in ('reviewInfo', 'pr', 'prs', 'landing'): v.pop(k, None)
        v['actions'] = [a for a in v.get('actions') or [] if a.get('name') in ('followUp', 'cancel')] or [
            {'name': 'followUp', 'kind': 'signal', 'label': 'Send follow-up', 'enabled': True,
             'args': [{'name': 'text', 'type': 'text', 'label': 'Message', 'required': True}]},
            {'name': 'cancel', 'kind': 'signal', 'label': 'Cancel', 'enabled': True, 'danger': True}]
    save(tid, v, p)

def tidy(project, num):
    """Drop the setup-warning lines a world prints before the agent starts (noise on screen)."""
    tid, _, _ = task(project, num)
    row = db.execute('SELECT conversation FROM tasks WHERE id=?', (tid,)).fetchone()
    if not row or not row[0]: return
    c = json.loads(row[0])
    keep = lambda ms: [m for m in ms if not str(m.get('text', '')).startswith('Setup warning:')]
    c['messages'] = keep(c.get('messages') or [])
    for t in c.get('transcripts') or []: t['messages'] = keep(t.get('messages') or [])
    with db: db.execute('UPDATE tasks SET conversation=? WHERE id=?', (json.dumps(c), tid))

def first_message_only(project, num):
    """The conversation as it stood while the agent's first turn ran."""
    tid, _, _ = task(project, num)
    c = json.loads(db.execute('SELECT conversation FROM tasks WHERE id=?', (tid,)).fetchone()[0])
    c['messages'] = c['messages'][:1]
    for t in c.get('transcripts') or []: t['messages'] = t['messages'][:1]
    with db: db.execute('UPDATE tasks SET conversation=? WHERE id=?', (json.dumps(c), tid))

SCENES = {
    'hero-working': lambda: [first_message_only('personal-website', 5), working('personal-website', 5, fresh=True)],
    'tidy': lambda: [tidy('personal-website', 5), tidy('legibench3', 19), tidy('thesis', 8), tidy('lvpm', 8)],
    # The org at work: a mix of real states, plus a few agents mid-turn.
    'busy': lambda: [working('tavya', 836), working('solib', 5), working('legibench3', 23), working('takehomev2', 28),
                     in_review('personal-website', 5), in_review('lvpm', 8), in_review('legibench3', 20)],
    'review': lambda: in_review('personal-website', 5),
    'merged': lambda: merged('personal-website', 5),
}
for scene in sys.argv[2:]: SCENES[scene]()
