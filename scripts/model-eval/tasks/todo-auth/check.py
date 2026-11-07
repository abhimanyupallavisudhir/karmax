import json, subprocess, sys, os, tempfile, time, urllib.request, socket
work = sys.argv[1]
s0 = socket.socket(); s0.bind(('127.0.0.1', 0)); port = s0.getsockname()[1]; s0.close()
data = os.path.join(tempfile.mkdtemp(), 'db.json'); env = {**os.environ, 'PORT': str(port), 'DATA_FILE': data}
def start():
    p = subprocess.Popen(['node', 'server.js'], cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: socket.create_connection(('127.0.0.1', port), 0.2).close(); return p
        except OSError: time.sleep(0.1)
    raise SystemExit('FAIL: server did not start')
def req(method, path, body=None, token=None):
    h = {'Content-Type': 'application/json'}
    if token: h['Authorization'] = 'Bearer ' + token
    r = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp: b = resp.read(); return resp.status, (json.loads(b) if b else None)
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, (json.loads(b) if b else None)
        except Exception: return e.code, '<non-json>'
fails = []
def check(n, c):
    if not c: fails.append(n)
PW = 'correct horse battery'
p = start()
try:
    s, u = req('POST', '/signup', {'username': 'alice', 'password': PW}); check('signup', s == 201 and u.get('username') == 'alice' and 'id' in u and 'password' not in json.dumps(u))
    check('signup bob', req('POST', '/signup', {'username': 'bob_2', 'password': 'hunter2hunter2'})[0] == 201)
    check('dup 409', req('POST', '/signup', {'username': 'alice', 'password': PW})[0] == 409)
    for bad in [{'username': 'Al', 'password': PW}, {'username': 'Alice', 'password': PW}, {'username': 'carol', 'password': 'short'}, {'username': 'x' * 21, 'password': PW}, {'username': 'carol'}, {}]:
        check(f'signup 400 {bad}', req('POST', '/signup', bad)[0] == 400)
    check('login wrong pw', req('POST', '/login', {'username': 'alice', 'password': 'nope nope nope'})[0] == 401)
    check('login unknown', req('POST', '/login', {'username': 'zed', 'password': PW})[0] == 401)
    s, a = req('POST', '/login', {'username': 'alice', 'password': PW}); ta = (a or {}).get('token'); check('login', s == 200 and isinstance(ta, str))
    s, b = req('POST', '/login', {'username': 'bob_2', 'password': 'hunter2hunter2'}); tb = (b or {}).get('token')
    check('no token 401', req('GET', '/todos')[0] == 401)
    check('bad token 401', req('GET', '/todos', token='garbage')[0] == 401)
    check('no token post 401', req('POST', '/todos', {'title': 'x'})[0] == 401)
    s, t1 = req('POST', '/todos', {'title': 'alice one'}, ta); check('alice create', s == 201 and t1['title'] == 'alice one')
    s, t2 = req('POST', '/todos', {'title': 'bob one'}, tb); check('bob create', s == 201)
    s, l = req('GET', '/todos', token=ta); check('alice list', s == 200 and [t['title'] for t in l] == ['alice one'])
    s, l = req('GET', '/todos', token=tb); check('bob list', s == 200 and [t['title'] for t in l] == ['bob one'])
    check('cross get 404', req('GET', f"/todos/{t2['id']}", token=ta)[0] == 404)
    check('cross patch 404', req('PATCH', f"/todos/{t2['id']}", {'done': True}, ta)[0] == 404)
    check('cross delete 404', req('DELETE', f"/todos/{t2['id']}", token=ta)[0] == 404)
    s, t = req('GET', f"/todos/{t2['id']}", token=tb); check('bob still has it', s == 200 and t['done'] is False)
    check('validation kept', req('POST', '/todos', {'title': '  '}, ta)[0] == 400)
    check('filter kept', req('GET', '/todos?done=true', token=ta) == (200, []))
    s, b2 = req('POST', '/login', {'username': 'bob_2', 'password': 'hunter2hunter2'}); tb2 = (b2 or {}).get('token')
    check('logout 204', req('POST', '/logout', token=tb)[0] == 204)
    check('logged out token 401', req('GET', '/todos', token=tb)[0] == 401)
    check('other session ok', req('GET', '/todos', token=tb2)[0] == 200)
finally:
    p.terminate(); p.wait()
raw = open(data).read() if os.path.exists(data) else ''
check('data file written', bool(raw))
check('no plaintext password', PW not in raw and 'hunter2hunter2' not in raw)
p = start()
try:
    s, l = req('GET', '/todos', token=ta); check('token survives restart', s == 200 and [t['title'] for t in l] == ['alice one'])
    check('login after restart', req('POST', '/login', {'username': 'bob_2', 'password': 'hunter2hunter2'})[0] == 200)
    check('logout survives restart', req('GET', '/todos', token=tb)[0] == 401)
finally:
    p.terminate(); p.wait()
print('FAIL' if fails else 'PASS', fails); sys.exit(1 if fails else 0)
