#!/usr/bin/env python3
"""Summarize Ask evaluation results (README.md): one row per model, one column per scenario.

    python3 -I scripts/ask-eval/summarize.py scripts/ask-eval/results/2026-11-19.jsonl [--markdown]
"""
import json
import math
import statistics
import sys
from collections import defaultdict

path = sys.argv[1]
rows = [json.loads(line) for line in open(path) if line.strip()]
by_model = defaultdict(list)
for r in rows:
    by_model[r['model']].append(r)
scenarios = list(dict.fromkeys(r['scenario'] for r in rows))
SHORT = {
    'waiting-for+reply': 'wait+reply', 'failed-this-week': 'failed', 'wiki-summary': 'wiki', 'raise-priority': 'priority',
    'start-on-computer': 'computer', 'weekly-draft': 'schedule', 'tell-me-when-done': 'notify', 'answer-subtask': 'sub-task',
    'cancel': 'cancel', 'delete-held-back': 'delete', 'find-create-follow': 'multi-step', 'inbox-events': 'events',
    'secret-form': 'form', 'rename-project': 'rename',
}


def med(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def p90(values):
    values = sorted(v for v in values if v is not None)
    return values[max(0, math.ceil(0.9 * len(values)) - 1)] if values else None


def fmt_s(ms):
    return '—' if ms is None else f'{ms / 1000:.1f}'


# Writes an Ask may make for each request; any other write is one nobody asked for.
WRITES = {'set_execution_policy', 'propose_workflow_edit', 'emit_event', 'tag_task', 'reorder_queue', 'connect_world_provider',
          'disconnect_world_provider', 'store_credential', 'save_skill', 'stop_agent', 'fork_agent', 'signal_task', 'queue_task',
          'set_task_priority', 'create_task', 'create_sub_task', 'message_agent', 'respond_to_sub_task', 'request_connection',
          'generate', 'request_spend', 'execute_connection_tool', 'request_agent_action', 'platform_request'}
CREATE = {'create_task', 'queue_task', 'POST /api/projects/*/tasks', 'POST /api/tasks/*/queue'}
MESSAGE = {'message_agent', 'signal_task followUp', 'respond_to_sub_task', 'POST /api/tasks/*/messages', 'POST /api/tasks/*/signal'}
EXPECTED = {
    'waiting-for+reply': MESSAGE, 'answer-subtask': MESSAGE,
    'raise-priority': {'set_task_priority', 'PATCH /api/tasks/*/params', 'PUT /api/tasks/*/priority', 'PATCH /api/tasks/*/priority'},
    'start-on-computer': CREATE, 'weekly-draft': CREATE, 'find-create-follow': CREATE,
    'cancel': {'signal_task cancel', 'POST /api/tasks/*/signal', 'POST /api/tasks/*/cancel'},
    'rename-project': {'PATCH /api/projects/*'},
}


def write_kind(call, own):
    name, _, rest = call.partition(' ')
    if name not in WRITES:
        return None
    try:
        args = json.loads(rest)
    except ValueError:
        args = {}
    if name == 'platform_request':
        method = str(args.get('method', 'GET')).upper()
        if method == 'GET':
            return None
        import re
        route = str(args.get('path', '')).split('?')[0].replace(own, 'SELF')
        if route.startswith('/api/tasks/SELF'):
            return None  # its own task: follow-up triggers, params (what add_follow_up_trigger's description says)
        route = re.sub(r'/(task|proj|org|areq)_[a-z0-9]+', lambda m: '/*', route)
        return f'{method} {route}'
    if name == 'signal_task':
        return f"signal_task {args.get('signal')}"
    return name


def unrequested(r):
    allowed = EXPECTED.get(r['scenario'], set())
    kinds = [k for k in (write_kind(c, r['askId']) for c in r.get('calls', [])) if k]
    # One creation is the request; a second task is not.
    extra = [k for k in kinds if k not in allowed]
    created = [k for k in kinds if k in CREATE and k != 'queue_task' and k != 'POST /api/tasks/*/queue']
    return extra + created[1:]


table = []
for model, rs in by_model.items():
    passed = sum(r['pass'] for r in rs)
    cells = []
    for s in scenarios:
        sr = [r for r in rs if r['scenario'] == s]
        cells.append(f"{sum(r['pass'] for r in sr)}/{len(sr)}" if sr else '')
    first = [r['turns'][0].get('firstTokenMs') for r in rs if r['turns']]
    first_text = [r['turns'][0].get('firstTextMs') for r in rs if r['turns']]
    end = [r['turns'][-1].get('endMs') for r in rs if r['turns']]
    table.append({
        'model': model, 'n': len(rs), 'passed': passed, 'rate': passed / len(rs), 'cells': cells,
        'cost': statistics.mean(r['costUsd'] for r in rs),
        'cost_median': med([r['costUsd'] for r in rs]),
        'first': med(first), 'first_text': med(first_text), 'end': med(end),
        'end_p90': p90(end),
        'rounds': med([r['rounds'] for r in rs]),
        'prompt': med([r['promptTokens'] for r in rs]),
        'cached': sum(r['cachedTokens'] for r in rs) / max(1, sum(r['promptTokens'] for r in rs)),
        'out': med([r['completionTokens'] for r in rs]),
        'tool_errors': sum(len(r['toolErrors']) for r in rs) / max(1, sum(len(r['tools']) for r in rs)),
        'unknown': sum(r['unknownTools'] for r in rs), 'bad_json': sum(r['badJson'] for r in rs),
        'did_nothing': sum(r['endedWithoutDoing'] for r in rs),
        'unrequested': sum(1 for r in rs if unrequested(r)) / len(rs),
        'clean': sum(1 for r in rs if r['pass'] and not unrequested(r)),
        'unrequested_examples': sorted({k for r in rs for k in unrequested(r)}),
        'timed_out': sum(r['timedOut'] for r in rs),
        'provider_errors': sum(len(r['providerErrors']) for r in rs),
    })
table.sort(key=lambda t: (-t['rate'], t['cost']))

if '--markdown' in sys.argv:
    print('| Model:effort | Pass | Clean pass | ' + ' | '.join(SHORT.get(s, s) for s in scenarios) + ' |')
    print('|---|---|---|' + '---|' * len(scenarios))
    for t in table:
        print(f"| {t['model']} | **{t['passed']}/{t['n']}** | {t['clean']}/{t['n']} | " + ' | '.join(t['cells']) + ' |')
    print()
    print('| Model:effort | $ / Ask (mean) | First token s | Turn s (median / p90) | Rounds | Prompt tok | Cached | Output tok | Tool errors | Unknown tools | Bad JSON | Unrequested writes | Timeouts |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for t in table:
        print(f"| {t['model']} | ${t['cost']:.4f} | {fmt_s(t['first'])} | {fmt_s(t['end'])} / {fmt_s(t['end_p90'])} | {t['rounds']:.0f} | "
              f"{t['prompt'] / 1000:.0f}k | {t['cached']:.0%} | {t['out'] / 1000:.1f}k | {t['tool_errors']:.0%} | {t['unknown']} | {t['bad_json']} | {t['unrequested']:.0%} | {t['timed_out']} |")
else:
    for t in table:
        print(f"{t['model']:<44} {t['passed']:>3}/{t['n']:<3} clean {t['clean']:>3} ${t['cost']:.4f}/Ask  first {fmt_s(t['first'])}s  turn {fmt_s(t['end'])}s (p90 {fmt_s(t['end_p90'])})  "
              f"rounds {t['rounds']:.0f}  cached {t['cached']:.0%}  tool-err {t['tool_errors']:.0%}  unrequested {t['unrequested']:.0%} {t['unrequested_examples'][:6]}  timeouts {t['timed_out']}")
        print('    ' + '  '.join(f"{SHORT.get(s, s)} {c}" for s, c in zip(scenarios, t['cells'])))
    print(f"\n{len(rows)} trials, ${sum(r['costUsd'] for r in rows):.2f} spent")
