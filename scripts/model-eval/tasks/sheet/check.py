import sys, importlib.util, math
spec = importlib.util.spec_from_file_location('sheet', sys.argv[1] + '/sheet.py'); m = importlib.util.module_from_spec(spec); sys.modules['sheet'] = m; spec.loader.exec_module(m)
fails = []
def eq(a, b): return (isinstance(b, (int, float)) and not isinstance(b, bool) and isinstance(a, (int, float)) and not isinstance(a, bool) and math.isclose(a, b, abs_tol=1e-9)) or a == b
def chk(name, got, want):
    if not eq(got, want): fails.append(f'{name}: got {got!r} want {want!r}')
def case(name, cells, expect):
    try:
        s = m.Sheet()
        for c, v in cells: s.set(c, v)
        for c, w in expect.items(): chk(f'{name} {c}', s.get(c), w)
        return s
    except Exception as e: fails.append(f'{name}: raised {type(e).__name__}: {e}')
case('basic', [('A1', '3'), ('A2', '-2.5'), ('A3', 'hello'), ('a4', '=A1*2+a2')], {'A1': 3, 'A2': -2.5, 'A3': 'hello', 'A4': 3.5, 'A5': None})
case('precedence', [('A1', '=2+3*4-(1+1)/4'), ('A2', '=-(2+3)*-2'), ('A3', '=2*-A9')], {'A1': 13.5, 'A2': 10, 'A3': 0})
case('functions', [('A1', '1'), ('A2', '2'), ('B1', 'x'), ('B2', '4'), ('C1', '=sum(A1:B2)'), ('C2', '=AVERAGE(B2:A1, 10)'), ('C3', '=MIN(A1:B2,-1)'), ('C4', '=max(A1:A2)*2'), ('C5', '=MAX(D1:D9)'), ('C6', '=SUM(A1, A2*10, 0.5)')],
     {'C1': 7, 'C2': 4.25, 'C3': -1, 'C4': 4, 'C5': 0, 'C6': 21.5})
case('errors', [('A1', '=1/0'), ('A2', '=A1+1'), ('A3', 'text'), ('A4', '=A3*2'), ('A5', '=FOO(1)'), ('A6', '=1+'), ('A7', '=AA1+1'), ('A8', '=AVERAGE(A3:A3)'), ('A9', '=A4+A2'), ('B1', '=A2+A4'), ('B2', '=SUM(A1:A2)'), ('B3', '=(1'), ('B4', '=A0+1')],
     {'A1': '#DIV/0!', 'A2': '#DIV/0!', 'A4': '#VALUE!', 'A5': '#NAME?', 'A6': '#ERROR!', 'A7': '#ERROR!', 'A8': '#DIV/0!', 'A9': '#VALUE!', 'B1': '#DIV/0!', 'B2': '#DIV/0!', 'B3': '#ERROR!', 'B4': '#ERROR!'})
case('cycle', [('A1', '=B1+1'), ('B1', '=C1'), ('C1', '=A1'), ('D1', '=A1*2'), ('E1', '=5'), ('F1', '=F1'), ('G1', '=SUM(G1:G2)')],
     {'A1': '#CYCLE!', 'B1': '#CYCLE!', 'C1': '#CYCLE!', 'D1': '#CYCLE!', 'E1': 5, 'F1': '#CYCLE!', 'G1': '#CYCLE!'})
s = case('updates', [('A1', '1'), ('A2', '=A1+1'), ('A3', '=A2*10')], {'A3': 20})
if s:
    try:
        s.set('A1', '5'); chk('update chain', s.get('A3'), 60)
        s.set('A1', '=A3'); chk('new cycle', s.get('A2'), '#CYCLE!')
        s.set('A1', '2'); chk('cycle broken', s.get('A3'), 30)
        s.set('A1', ''); chk('cleared', s.get('A1'), None); chk('cleared dep', s.get('A3'), 10)
        for i in range(1, 99): s.set(f'Z{i+1}', f'=Z{i}+1')
        s.set('Z1', '1'); chk('deep chain', s.get('Z99'), 99)
    except Exception as e: fails.append(f'updates raised {type(e).__name__}: {e}')
print('FAIL' if fails else 'PASS', fails); sys.exit(1 if fails else 0)
