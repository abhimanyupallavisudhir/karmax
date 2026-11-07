import json, subprocess, sys, os, tempfile, time, urllib.request, datetime, socket
work = sys.argv[1]
def free_port():
    s=socket.socket(); s.bind(('127.0.0.1',0)); p=s.getsockname()[1]; s.close(); return p
port=free_port(); data=os.path.join(tempfile.mkdtemp(),'db.json')
env={**os.environ,'PORT':str(port),'DATA_FILE':data}
def start():
    p=subprocess.Popen(['node','server.js'],cwd=work,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: socket.create_connection(('127.0.0.1',port),0.2).close(); return p
        except OSError: time.sleep(0.1)
    raise SystemExit('FAIL: server did not start')
def req(method,path,body=None,raw=None):
    data_=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r=urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=data_,method=method,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(r,timeout=5) as resp: b=resp.read(); return resp.status,(json.loads(b) if b else None)
    except urllib.error.HTTPError as e:
        b=e.read()
        try: return e.code,(json.loads(b) if b else None)
        except Exception: return e.code,'<non-json>'
fails=[]
def check(name,cond):
    if not cond: fails.append(name)
p=start()
try:
    today=datetime.date.today(); past=(today-datetime.timedelta(days=3)).isoformat(); fut=(today+datetime.timedelta(days=3)).isoformat()
    s,a=req('POST','/todos',{'title':'  buy milk  '}); check('create 201',s==201 and a and a['id']==1 and a['title']=='buy milk' and a['done'] is False and a['due'] is None and 'created_at' in a)
    s,b=req('POST','/todos',{'title':'pay rent','due':past}); check('create due',s==201 and b['id']==2 and b['due']==past)
    s,c=req('POST','/todos',{'title':'plan trip','due':fut}); check('create 3',s==201 and c['id']==3)
    for bad in [{'title':'   '},{},{'title':5},{'title':'x','due':'2026-02-30'},{'title':'x','due':'tomorrow'}]:
        s,e=req('POST','/todos',bad); check(f'400 {bad}',s==400 and isinstance(e,dict) and 'error' in e)
    s,e=req('POST','/todos',raw=b'{not json'); check('bad json 400',s==400 and isinstance(e,dict))
    s,l=req('GET','/todos'); check('list',s==200 and [t['id'] for t in l]==[1,2,3])
    s,t=req('GET','/todos/2'); check('get',s==200 and t['title']=='pay rent')
    s,t=req('GET','/todos/99'); check('get 404',s==404 and isinstance(t,dict) and 'error' in t)
    s,l=req('GET','/todos?overdue=true'); check('overdue',s==200 and [t['id'] for t in l]==[2])
    s,t=req('PATCH','/todos/2',{'done':True}); check('patch done',s==200 and t['done'] is True and t['title']=='pay rent')
    s,l=req('GET','/todos?overdue=true'); check('overdue after done',s==200 and l==[])
    s,l=req('GET','/todos?done=true'); check('filter done',s==200 and [t['id'] for t in l]==[2])
    s,l=req('GET','/todos?done=false'); check('filter not done',s==200 and [t['id'] for t in l]==[1,3])
    s,t=req('PATCH','/todos/1',{'done':'yes'}); check('patch bad done',s==400)
    s,t=req('PATCH','/todos/1',{'title':''}); check('patch bad title',s==400)
    s,t=req('PATCH','/todos/3',{'due':None}); check('patch due null',s==200 and t['due'] is None)
    s,t=req('PATCH','/todos/42',{'done':True}); check('patch 404',s==404)
    s,t=req('DELETE','/todos/3'); check('delete',s==204 and t is None)
    s,t=req('DELETE','/todos/3'); check('delete 404',s==404)
    s,t=req('GET','/nope'); check('unknown route',s==404 and isinstance(t,dict))
finally:
    p.terminate(); p.wait()
p=start()
try:
    s,l=req('GET','/todos'); check('persist',s==200 and [t['id'] for t in l]==[1,2] and l[1]['done'] is True)
    s,t=req('POST','/todos',{'title':'new'}); check('id not reused',s==201 and t['id']==4)
finally:
    p.terminate(); p.wait()
print('FAIL' if fails else 'PASS', fails); sys.exit(1 if fails else 0)
