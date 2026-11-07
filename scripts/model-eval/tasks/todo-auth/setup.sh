#!/bin/bash
cp -r "$(dirname "$0")/repo" "$1" && cd "$1" && git init -q && git add -A && git -c user.email=dev@example.com -c user.name=dev commit -qm "todo api"
