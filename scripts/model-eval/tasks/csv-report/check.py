import json, subprocess, sys, os, tempfile, csv, io, datetime
work = sys.argv[1]
rows = [
 ["order_id","date","customer","product","quantity","unit_price"],
 ["1","2026-01-05","Acme, Inc.","Widget","3","2.50"],
 ["2","2026-01-17","Bolt","Gadget","1","10"],
 ["3","2026-02-01","Acme, Inc.","Widget","2","2.50"],
 ["4","2026-02-30","Bolt","Widget","1","2.50"],      # bad date
 ["5","2026-03-03","Cog","Gizmo","0","4"],           # qty 0
 ["6","2026-03-03","Cog","Gizmo","2.5","4"],         # non-int qty
 ["7","2026-03-04","Cog","Gizmo","4","abc"],         # bad price
 ["8","2026-03-04","","Gizmo","4","1"],              # empty customer
 ["2","2026-03-05","Bolt","Gadget","5","10"],        # duplicate id
 ["9","2026-03-09","Dyn","Gadget","1","10"],
 ["10","2026-03-10","Cog","Gizmo","5","1.10"],
 ["11","2026-12-31","Eve","Gizmo","1","-1"],         # negative price
 ["12","2026-12-31","Eve","Sprocket","2","0.335"],
]
exp = {"total_revenue": 38.67, "orders": 6, "skipped": 7,
       "revenue_by_month": {"2026-01": 17.5, "2026-02": 5.0, "2026-03": 15.5, "2026-12": 0.67},
       "top_customers": [{"customer":"Acme, Inc.","revenue":12.5},{"customer":"Bolt","revenue":10.0},{"customer":"Dyn","revenue":10.0}],
       "best_product": "Gizmo"}
# Gizmo units: 5 (row 10); Widget: 3+2=5 -> tie -> "Gizmo" alphabetically first
d = tempfile.mkdtemp(); p = os.path.join(d, "o.csv")
with open(p, "w", newline="") as f: csv.writer(f).writerows(rows)
fails = []
try:
    out = subprocess.run([sys.executable, "report.py", p], cwd=work, capture_output=True, text=True, timeout=60)
    got = json.loads(out.stdout)
except Exception as e:
    print("FAIL run:", e, (out.stderr if 'out' in dir() else '')[-500:]); sys.exit(1)
def close(a,b): return isinstance(a,(int,float)) and abs(a-b) < 0.006
for k,v in exp.items():
    g = got.get(k)
    if k in ("total_revenue",) and not close(g,v): fails.append((k,g,v))
    elif k in ("orders","skipped","best_product") and g != v: fails.append((k,g,v))
    elif k == "revenue_by_month":
        if not isinstance(g,dict) or list(g.keys()) != list(v.keys()) or any(not close(g[m],v[m]) for m in v): fails.append((k,g,v))
    elif k == "top_customers":
        if not isinstance(g,list) or len(g)!=3 or any(a.get("customer")!=b["customer"] or not close(a.get("revenue"),b["revenue"]) for a,b in zip(g,v)): fails.append((k,g,v))
if set(got.keys()) != set(exp.keys()): fails.append(("keys", sorted(got.keys()), sorted(exp.keys())))
# empty file
with open(p, "w") as f: f.write("order_id,date,customer,product,quantity,unit_price\n")
out = subprocess.run([sys.executable, "report.py", p], cwd=work, capture_output=True, text=True, timeout=60)
try:
    g = json.loads(out.stdout)
    if g.get("orders") != 0 or g.get("best_product") is not None or g.get("top_customers") != [] or not close(g.get("total_revenue"),0): fails.append(("empty", g))
except Exception as e: fails.append(("empty-run", str(e)))
print("FAIL" if fails else "PASS", fails); sys.exit(1 if fails else 0)
