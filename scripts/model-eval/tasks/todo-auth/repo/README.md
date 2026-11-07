# Todo API

A small JSON REST API using Node.js 22 and no npm dependencies.

```sh
node server.js
# Or choose a port and data file:
PORT=3001 DATA_FILE=./my-todos.json node server.js
```

The defaults are port `3000` and `./todos.json` (relative to the working directory). The data file stores both the todos and the next ID; keep it when moving or backing up the data. The parent directory must already exist.

```sh
# Create a todo (due is optional).
curl -X POST http://localhost:3000/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"Buy milk","due":"2026-12-31"}'

# List all todos, completed todos, or overdue incomplete todos.
curl http://localhost:3000/todos
curl 'http://localhost:3000/todos?done=true'
curl 'http://localhost:3000/todos?overdue=true'

# Retrieve, update, or delete a todo.
curl http://localhost:3000/todos/1
curl -X PATCH http://localhost:3000/todos/1 \
  -H 'Content-Type: application/json' \
  -d '{"done":true,"due":null}'
curl -X DELETE http://localhost:3000/todos/1
```

`done=false` filters for incomplete todos. Filters can be combined. A todo is overdue when it is incomplete and its due date is before today's UTC date. Dates must be real calendar dates in `YYYY-MM-DD` form. A PATCH may update `title`, `done`, and/or `due`; setting `due` to `null` clears it. Successful deletion returns HTTP 204 with an empty body; other responses are JSON.

Run the integration tests with `node --test`.
