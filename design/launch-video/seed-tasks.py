import json, sqlite3, secrets, glob, os
db = sqlite3.connect('/tmp/demo/home/state/karmax.db'); db.row_factory = sqlite3.Row
projects = json.load(open('/tmp/demo/projects.json'))
USER = sqlite3.connect('/tmp/demo/home/state/auth.db').execute('select id from user limit 1').fetchone()[0]
CUT = {'tavya': 815, 'personal-website': 7}
new_ids = {}  # production task id → clone task id, for sub-task links
links = []
for name, pid in projects.items():
    tasks = json.load(open(f'/tmp/demo/prod/tasks-{name}.json'))
    lst = db.execute('select listId, createdBy, params, num, id from tasks where projectId=?', (pid,)).fetchone()
    list_id = lst['listId']; created_by = json.dumps({'kind':'user','userId':USER})
    default_id = lst['id']; db.execute('update tasks set num=NULL where id=?', (default_id,))
    n = 0
    for t in tasks:
        if t['num'] >= CUT.get(name, 10**9) or t['stage'] is None: continue
        if t['title'].startswith('Repair GitHub workflow'):
            db.execute('update tasks set num=?, createdAt=? where id=?', (t['num'], t['createdAt'], default_id)); continue
        if t['status'] not in ('done', 'cancelled', 'failed'): t['stage'] = t['status'] = 'done'
        tid = 'task_' + secrets.token_hex(8)
        if t.get('id'): new_ids[t['id']] = tid
        if t.get('parentTaskId'): links.append((tid, t['parentTaskId']))
        lv = {'taskId': tid, 'title': t['title'], 'workflow': t['workflow'], 'stage': t['stage'], 'status': t['status'], 'actions': [],
              'participants': [{'key': 'do', 'role': 'do', 'label': 'Agent', 'state': 'idle', 'messages': 1}],
              'state': {'cancelled': t['status'] == 'cancelled', 'confirmed': t['status'] == 'done', 'turnsSeen': 2, 'worldReady': False},
              'editableParams': [], 'workflowOptions': ['software-dev', 'goal'], 'workflowSwitchable': False, 'pointOfNoReturnPassed': True, 'worldAvailable': False}
        done = t['status'] in ('done', 'cancelled', 'failed')
        # Its conversation starts with its prompt, so an opened task shows what was asked.
        convo = {'messages': [{'id': 'm0', 'role': 'user', 'text': t['prompt'], 'ts': t['createdAt']}]} if t['prompt'] else None
        db.execute('''insert into tasks (id, projectId, listId, title, workflow, workflowVersion, params, createdAt, ord, lastView, completedAt, statusChangedAt, createdBy, executionWorkflow, intentId, attemptNumber, num, conversation)
          values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (tid, pid, list_id, t['title'], t['workflow'], '1.30.0', json.dumps({'prompt': t['prompt']}), t['createdAt'], t['num'],
          json.dumps(lv), t['statusChangedAt'] if done else None, t['statusChangedAt'], created_by, t['workflow'], tid, 1, t['num'], json.dumps(convo) if convo else None))
        db.execute('insert into task_intents (id, principalAttemptId, committedAttemptId, confirmer, createdAt) values (?,?,?,?,?)', (tid, tid, tid if done else None, json.dumps({'layers':[{'kind':'human','audience':['@creator']}]}), t['createdAt']))
        n += 1
    print(name, n)
# Sub-tasks under their parents (the Sub-tasks panel), where both are in the clone.
for tid, parent in links:
    if parent in new_ids: db.execute('update tasks set parentTaskId=? where id=?', (new_ids[parent], tid))
db.commit()
