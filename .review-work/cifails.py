import json,re,sys
d=json.loads(open(sys.argv[1]).read())
print('jobs:', [(j['name'], j.get('conclusion')) for j in d['jobs']])
for fj in d['failedJobs']:
    ex=fj['log']['excerpt']
    fails=sorted(set(re.findall(r' FAIL  (\S+\.test\.\w+) > (.+)$', ex, re.M)))
    summ=re.findall(r'(Test Files .+|Tests  .+)', ex)
    print('==', fj['name'], summ[-2:] if summ else '')
    for f,t in fails: print('   ', f, '>', t[:150])
    for m in re.finditer(r' FAIL  (\S+) > (.+)\n(.+)\n', ex):
        print('      ERR', m.group(1).split('/')[-1], '|', m.group(3)[29:220])
