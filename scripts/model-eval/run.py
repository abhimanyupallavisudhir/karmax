#!/usr/bin/env python3
"""tavya's model evaluation (wiki features/included-model): run each task with
each model through OpenCode, the release tavya pins, grade it with the task's
hidden check, and record what it cost at OpenRouter's prices.

usage: run.py --models deepseek/deepseek-v4.1-flash-1017:max,openai/gpt-6.1-terra:medium
              [--reps 2] [--tasks k-mail,sheet] [--parallel 4] [--any-provider] [--output-max 64000]

A model is an OpenRouter id with an optional `:<effort>` (OpenCode's variant).
Turns are routed as tavya routes the included model (INCLUDED_MODEL_OPTIONS):
only providers that keep no prompts, no 4-bit builds; --any-provider lets
OpenRouter choose. Needs OPENROUTER_API_KEY and the one-time setup.sh. Stops
launching runs once the key has spent MODEL_EVAL_BUDGET (default $20).
Results: runs/<task>/<model>/<rep>/ (result.json, events, the agent's diff);
a finished run is never redone. summarize.py tabulates them.
"""
import argparse, json, os, random, secrets, subprocess, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.environ.get('MODEL_EVAL_RUNS', os.path.join(HERE, 'runs'))
OPT = '/opt/model-eval'
BOXES = '/srv/model-eval'
OPENCODE = f'{OPT}/opencode/node_modules/.bin/opencode'
AGENT_PATH = f'{OPT}/node/bin:/usr/local/bin:/usr/bin:/bin'
KEY = os.environ.get('OPENROUTER_API_KEY', '').split('=', 1)[-1].strip()
BUDGET = float(os.environ.get('MODEL_EVAL_BUDGET', '20'))
API = 'https://openrouter.ai/api/v1'
# src/agent/included-model.ts INCLUDED_MODEL_OPTIONS
PRIVATE = {'zdr': True, 'quantizations': ['fp8', 'bf16', 'fp16', 'fp32', 'unknown']}

TASKS = {  # name: (agent time limit in seconds, grader)
    'csv-report': (900, ['python3', 'check.py']),
    'todo-api': (900, ['python3', 'check.py']),
    'semver-bug': (900, ['node', 'check.mjs']),
    'expense-app': (900, ['node', 'check.cjs']),
    'sheet': (1200, ['python3', 'check.py']),
    'todo-auth': (1200, ['python3', 'check.py']),
    'k-mail': (1800, ['./check.sh']),
    'k-pr-inventory': (1800, ['./check.sh']),
    'k-title': (1800, ['./check.sh']),
}


def get(path):
    request = urllib.request.Request(f'{API}{path}', headers={'Authorization': f'Bearer {KEY}'})
    return json.load(urllib.request.urlopen(request, timeout=30))


PRICES = {}


def step_cost(model, tokens):
    """USD of one model call at OpenRouter's list price, long-context tiers included."""
    price = PRICES[model]
    cache = tokens.get('cache', {})
    prompt = tokens.get('input', 0) + cache.get('read', 0) + cache.get('write', 0)
    for tier in price.get('overrides') or []:
        if prompt >= tier.get('min_prompt_tokens', 1 << 60):
            price = {**price, **tier}
    rate = lambda key, fallback=None: float(price.get(key) or (price.get(fallback) if fallback else 0) or 0)
    return (tokens.get('input', 0) * rate('prompt') + cache.get('read', 0) * rate('input_cache_read', 'prompt')
            + cache.get('write', 0) * rate('input_cache_write', 'prompt')
            + (tokens.get('output', 0) + tokens.get('reasoning', 0)) * rate('completion'))


lock = threading.Lock()
state = {'start': 0.0, 'stopped': False}


def run(task, spec, rep, args):
    model, _, effort = spec.partition(':')
    out = f'{RUNS}/{task}/{spec.replace("/", "_")}{"" if args.private else "@any"}/{rep}'
    if os.path.exists(f'{out}/result.json'):
        return
    with lock:
        if state['stopped']:
            return
        spent = get('/key')['data']['usage'] - state['start']
        if spent >= BUDGET:
            state['stopped'] = True
            print(f'budget reached (${spent:.2f}); launching nothing more', flush=True)
            return
    subprocess.run(['rm', '-rf', out]); os.makedirs(out)
    # The agent runs as the `agent` user: it cannot read this repository (the
    # graders, hidden tests and the fixes in its history) or list other runs.
    tag = secrets.token_hex(6); box = f'{BOXES}/{tag}'; work = f'{box}/work'
    os.makedirs(box)
    task_dir = f'{HERE}/tasks/{task}'
    subprocess.run([f'{task_dir}/setup.sh', work], check=True, capture_output=True,
                   env={**os.environ, 'MODEL_EVAL_DEPS': f'{OPT}/deps/node_modules'})
    if args.private:
        os.makedirs(f'{box}/xdg/config/opencode')
        with open(f'{box}/xdg/config/opencode/opencode.json', 'w') as config:
            json.dump({'provider': {'openrouter': {'models': {model: {'options': {'provider': PRIVATE}}}}}}, config)
    subprocess.run(['sudo', 'chown', '-R', 'agent:agent', box], check=True)
    subprocess.run(['sudo', 'chmod', '700', box], check=True)
    limit, grader = TASKS[task]
    env = ['env', '-i', f'PATH={AGENT_PATH}', 'HOME=/home/agent', 'LANG=C.UTF-8', 'TERM=dumb', f'OPENROUTER_API_KEY={KEY}',
           f'XDG_DATA_HOME={box}/xdg/data', f'XDG_STATE_HOME={box}/xdg/state', f'XDG_CONFIG_HOME={box}/xdg/config',
           f'XDG_CACHE_HOME={OPT}/cache', f'MODEL_EVAL_RUN={tag}']
    if args.output_max:
        env.append(f'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX={args.output_max}')
    with open(f'{task_dir}/prompt.md') as prompt:
        opencode = [OPENCODE, 'run', '--auto', '--format', 'json', '-m', f'openrouter/{model}',
                    *(['--variant', effort] if effort else []), prompt.read()]
    started = time.time()
    with open(f'{out}/events.jsonl', 'w') as stdout, open(f'{out}/stderr.txt', 'w') as stderr:
        process = subprocess.Popen(['sudo', '-u', 'agent', 'bash', '-c', f'cd {work} && exec "$@"', '_', *env, *opencode],
                                   stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            process.wait(timeout=limit); timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
        # Every process of the run (servers, test runners) carries MODEL_EVAL_RUN.
        subprocess.run(['sudo', 'bash', '-c', f'for d in /proc/[0-9]*; do grep -qz "^MODEL_EVAL_RUN={tag}$" $d/environ 2>/dev/null && kill -9 ${{d#/proc/}}; done'])
        process.wait()
    subprocess.run(['sudo', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', box], check=True)
    seconds = time.time() - started
    steps = 0; cost = 0.0; cut_off = False; max_prompt = 0
    tokens = {'input': 0, 'output': 0, 'reasoning': 0, 'cache_read': 0, 'cache_write': 0}
    with open(f'{out}/events.jsonl') as events:
        for line in events:
            try:
                part = json.loads(line).get('part') or {}
            except ValueError:
                continue
            if part.get('type') != 'step-finish':
                continue
            steps += 1; used = part.get('tokens') or {}; cache = used.get('cache', {})
            cost += step_cost(model, used)
            cut_off = part.get('reason') == 'length'  # the last call hit OpenCode's output cap
            for key in ('input', 'output', 'reasoning'):
                tokens[key] += used.get(key, 0)
            tokens['cache_read'] += cache.get('read', 0); tokens['cache_write'] += cache.get('write', 0)
            max_prompt = max(max_prompt, used.get('input', 0) + cache.get('read', 0) + cache.get('write', 0))
    graded = subprocess.run(grader + [work], cwd=task_dir, capture_output=True, text=True, timeout=1200)
    result = dict(task=task, model=model, effort=effort or None, private=args.private, rep=rep, passed=graded.returncode == 0,
                  grade=(graded.stdout + graded.stderr)[-1500:], timed_out=timed_out, cut_off=cut_off, seconds=round(seconds),
                  steps=steps, cost=round(cost, 5), tokens=tokens, max_prompt=max_prompt, output_max=args.output_max)
    with open(f'{out}/result.json', 'w') as file:
        json.dump(result, file, indent=1)
    subprocess.run(['bash', '-c', f'cd {work} && git add -A && git diff --cached --stat HEAD > {out}/diffstat.txt; '
                    f'git diff --cached HEAD -- . ":!node_modules" ":!**/__pycache__" > {out}/diff.patch'])
    subprocess.run(['rm', '-rf', box])
    print(f"{task:15s} {spec:40s} r{rep} {'PASS' if result['passed'] else 'fail'} ${cost:.3f} {steps} steps {round(seconds)}s"
          f"{' TIMEOUT' if timed_out else ''}{' CUT OFF' if cut_off else ''}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--models', required=True)
    parser.add_argument('--reps', type=int, default=2)
    parser.add_argument('--tasks', default=','.join(TASKS))
    parser.add_argument('--parallel', type=int, default=4)
    parser.add_argument('--any-provider', dest='private', action='store_false')
    parser.add_argument('--output-max', type=int)
    args = parser.parse_args()
    if not KEY:
        raise SystemExit('OPENROUTER_API_KEY is not set')
    if subprocess.run(['sudo', '-u', 'agent', 'test', '-r', f'{HERE}/run.py'], capture_output=True).returncode == 0:
        raise SystemExit('the agent user can read this repository; run setup.sh first (it makes your home directory private)')
    PRICES.update({m['id']: m['pricing'] for m in get('/models')['data']})
    models = args.models.split(',')
    unknown = [m for m in models if m.partition(':')[0] not in PRICES] + [t for t in args.tasks.split(',') if t not in TASKS]
    if unknown:
        raise SystemExit(f'unknown model or task: {", ".join(unknown)}')
    state['start'] = get('/key')['data']['usage']
    print(f'key has spent ${state["start"]:.2f}; budget ${BUDGET:.2f}', flush=True)
    jobs = [(task, model, rep) for rep in range(1, args.reps + 1) for task in args.tasks.split(',') for model in models]
    random.Random(7).shuffle(jobs)
    jobs.sort(key=lambda job: (job[2], not job[0].startswith('k-')))  # by repetition, slow karmax tasks first
    with ThreadPoolExecutor(args.parallel) as pool:
        for future in [pool.submit(run, *job, args) for job in jobs]:
            try:
                future.result()
            except Exception as error:  # one broken run must not stop the others
                print('run failed:', repr(error), flush=True)
    print(f'done; spent ${get("/key")["data"]["usage"] - state["start"]:.2f}', flush=True)


if __name__ == '__main__':
    main()
