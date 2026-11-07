#!/usr/bin/env python3
"""Tabulate run.py's results: per model, how many runs passed, what a run cost
at OpenRouter's prices (averaged over the tasks most models ran, so the
figures compare; — for a model that did not run them all), how long it took, and how many runs timed out or were cut
off by OpenCode's output cap. The last column is the line for
MEASURED_TASK_USD in src/agent/included-model.ts.

usage: summarize.py [results.jsonl …]   (default: $MODEL_EVAL_RUNS or runs/, as run.py)
"""
import glob, json, os, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))


def load(paths):
    if not paths:
        runs = os.environ.get('MODEL_EVAL_RUNS', os.path.join(HERE, 'runs'))
        return [json.load(open(p)) for p in glob.glob(f'{runs}/*/*/*/result.json')]
    return [json.loads(line) for p in paths for line in open(p) if line.strip()]


def main():
    results = load(sys.argv[1:])
    if not results:
        raise SystemExit('no results')
    by = defaultdict(list)
    for r in results:
        by[(r['model'], r.get('effort') or '', r.get('private', True), r.get('output_max'))].append(r)
    ran = [{r['task'] for r in runs} for runs in by.values()]
    count = {task: sum(task in tasks for tasks in ran) for task in set().union(*ran)}
    common = {task for task, n in count.items() if n == max(count.values())}
    print(f'{len(results)} runs; costs averaged over {", ".join(sorted(common))}\n')
    print(f"{'model':48s} {'passed':>7s} {'$/run':>7s} {'min':>5s} {'timeouts':>8s} {'cut off':>7s}   MEASURED_TASK_USD")
    rows = []
    for (model, effort, private, output_max), runs in by.items():
        shared = [r for r in runs if r['task'] in common]
        usd = sum(r['cost'] for r in shared) / len(shared) if common <= {r['task'] for r in runs} else None
        name = f"{model}:{effort}" + ('' if private else ' (any provider)') + (f' (output {output_max})' if output_max else '')
        rows.append((usd if usd is not None else 1e9, f"{name:48s} {sum(r['passed'] for r in runs):3d}/{len(runs):<3d} "
                     f"{f'{usd:7.4f}' if usd is not None else '      —'} {sum(r['seconds'] for r in runs) / len(runs) / 60:5.1f} "
                     f"{sum(r['timed_out'] for r in runs):8d} {sum(bool(r.get('cut_off')) for r in runs):7d}"
                     + (f"   '{model}:{effort}': {usd:.4f}," if usd is not None else '')))
    for _, row in sorted(rows):
        print(row)


if __name__ == '__main__':
    main()
