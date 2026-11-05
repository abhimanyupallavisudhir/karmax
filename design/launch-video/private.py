"""What the launch video must never show: friends' projects and organizations.

karmax is public, so the list itself lives in the private project wiki (ops/launch-video,
its ```private block: project names on the `projects:` line, then one pattern per line).
Point LAUNCH_VIDEO_PRIVATE at that page if the wiki is not checked out beside karmax.
A task is private when its summary, view or activity matches any pattern, and so is each
of its sub-tasks.
"""
import os
import re
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_page = os.environ.get('LAUNCH_VIDEO_PRIVATE') or os.path.join(
    _here, '..', '..', '..', 'krmax-wiki-8362c77d', 'ops', 'launch-video', 'SKILL.md')
try:
    _block = re.search(r'```private\n(.*?)```', open(_page).read(), re.S).group(1)
except (OSError, AttributeError):
    sys.exit(f'private.py: no ```private block in {_page} (see design/launch-video/README.md)')

_lines = [l.strip() for l in _block.splitlines() if l.strip()]
PRIVATE_PROJECTS = {p.strip() for l in _lines if l.startswith('projects:') for p in l[9:].split(',') if p.strip()}
TERMS = [l for l in _lines if not l.startswith('projects:')]
PRIVATE = re.compile('|'.join(TERMS), re.I)
