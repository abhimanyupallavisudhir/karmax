#!/usr/bin/env python3
"""Stamp docs/review-2026-09-26.md with verified statuses and write its Resolution.

Inputs: /tmp/verify/out-b*.tsv (ID, status, shas, note) and overrides.tsv
(same columns; later rows win). Usage: annotate.py DOC HEAD_SHA > NEW_DOC
"""
import collections, glob, re, sys

doc_path, head = sys.argv[1], sys.argv[2]
rows = {}
for f in sorted(glob.glob('/tmp/verify/out-b*.tsv')) + ['/tmp/verify/overrides.tsv']:
    try:
        lines = open(f).read().splitlines()
    except FileNotFoundError:
        continue
    for line in lines:
        if not line.strip():
            continue
        rid, status, shas, note = line.split('\t')
        rows[rid] = {'status': status, 'shas': [] if shas == '-' else shas.split(','), 'note': note}

ID = r'(?:UI|LT|RQ|PS|RT|WF|GW|PL|AU|GH|DB|CI|WD|AD|WK|PA)-\d+'
doc = open(doc_path).read().split('\n')
area_of, sev_of, text_of, subs_of = {}, {}, {}, collections.OrderedDict()
area = None
out = []
MARK = re.compile(r' \*\*\[(?:fixed|partial|open|deferred|invalid|checked|[0-9a-z]+ (?:fixed|partial|open|deferred|invalid|n/a))[^\]]*\]\*\*')
for line in doc:
    m = re.match(r'^## (.+?) \((\w+)\)\s*$', line)
    if m:
        area = m.group(2)
    m = re.match(rf'^- ({ID})(?:\.\.(\d+))?\b', line)
    if not m or area is None:
        out.append(line)
        continue
    base, upto = m.group(1), m.group(2)
    prefix, number = base.rsplit('-', 1)
    if upto:
        ids = [f'{prefix}-{n}' for n in range(int(number), int(upto) + 1)]
    else:
        ids = [base] if base in rows else sorted((k for k in rows if re.fullmatch(rf'{re.escape(base)}[a-z]', k)))
    body = MARK.sub('', line[len(m.group(0)):])
    sev = re.match(r'\s*\**\s*(CRIT|HIGH\(CRIT hosted\)|HIGH|MED|LOW-MED|LOW)', body)
    severity = sev.group(1) if sev else ''
    for rid in ids:
        area_of[rid], sev_of[rid] = area, severity
        subs_of.setdefault(base, []).append(rid)
    text_of[base] = body.strip()

    def tag(rid, short=False):
        r = rows.get(rid)
        if not r:
            return f'{rid[len(base):] if short else ""} unverified'.strip()
        label = {'n/a': 'checked'}.get(r['status'], r['status'])
        sha = f" {r['shas'][0]}" if r['status'] == 'fixed' and r['shas'] else ''
        who = (rid.rsplit('-', 1)[1] if upto else rid[len(base):]) if short else ''
        return f'{who} {label}{sha}'.strip()

    if not ids:
        marker = ' **[unverified]**'
    elif len(ids) == 1 and ids[0] == base:
        marker = f' **[{tag(base)}]**'
    else:
        marker = ' **[' + ' · '.join(tag(rid, short=True) for rid in ids) + ']**'
    out.append(line[:len(m.group(0))] + marker + body)

# Resolution section.
counts = collections.Counter(r['status'] for r in rows.values())
by_area = collections.defaultdict(collections.Counter)
for rid, r in rows.items():
    by_area[area_of.get(rid, '?')][r['status']] += 1
order = ['fixed', 'partial', 'open', 'deferred', 'invalid', 'n/a']
area_names = {}
for line in doc:
    m = re.match(r'^## (.+?) \((\w+)\)\s*$', line)
    if m:
        area_names[m.group(2)] = m.group(1)
res = ['## Resolution', '',
       f'Verified at `{head}`. Each finding (and each item of a bundled line) was re-checked read-only against the commits that claim it and the code at that head; CRIT and HIGH items along their full diff, naming the covering test. Statuses: **fixed**, **partial** (what remains is stated), **open**, **deferred** (deliberately not done, with the reason), **invalid** (the finding was wrong), **checked** (not a finding).',
       '', '| Area | ' + ' | '.join(s for s in order) + ' |', '| --- |' + ' --- |' * len(order)]
for code, name in area_names.items():
    c = by_area.get(code, {})
    res.append(f'| {name} ({code}) | ' + ' | '.join(str(c.get(s, 0)) for s in order) + ' |')
res.append('| **All** | ' + ' | '.join(f'**{counts.get(s, 0)}**' for s in order) + ' |')

def section(title, statuses, intro):
    items = [rid for rid, r in rows.items() if r['status'] in statuses]
    rank = {'CRIT': 0, 'HIGH(CRIT hosted)': 1, 'HIGH': 1, 'MED': 2, 'LOW-MED': 3, 'LOW': 4, '': 5}
    items.sort(key=lambda rid: (rank.get(sev_of.get(rid, ''), 5), list(area_names).index(area_of[rid]) if area_of.get(rid) in area_names else 99,
                                [int(p) if p.isdigit() else p for p in re.split(r'(\d+)', rid)]))
    if not items:
        return []
    lines = ['', f'### {title}', '', intro, '', '| ID | Sev | Status | What remains |', '| --- | --- | --- | --- |']
    for rid in items:
        r = rows[rid]
        note = r['note'].replace('|', '\\|')
        lines.append(f"| {rid} | {sev_of.get(rid, '')} | {r['status']} | {note} |")
    return lines

res += section('Still open', {'partial', 'open'},
               'Ranked by severity. The wiki page `reviews/2026-09-26` tracks these from here on.')
res += section('Deferred', {'deferred'}, 'Deliberately not done in this change; the reason is recorded.')
res += section('Invalid', {'invalid'}, 'The finding did not hold on inspection.')

text = '\n'.join(out)
start = text.index('\n## Resolution')
text = text[:start + 1] + '\n'.join(res) + '\n'
sys.stdout.write(text)
