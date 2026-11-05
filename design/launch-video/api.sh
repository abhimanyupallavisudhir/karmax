# usage: api METHOD PATH [JSON]
api() { curl -s -X "$1" "http://127.0.0.1:48950$2" -b "$(python3 -c "import json;print('; '.join(c['name']+'='+c['value'] for c in json.load(open('/tmp/demo/state.json'))['cookies']))")" -H "origin: http://127.0.0.1:48950" -H 'content-type: application/json' ${3:+-d "$3"}; }
