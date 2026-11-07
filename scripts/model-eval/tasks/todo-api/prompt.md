Build a small JSON REST API for a to-do list in Node.js 22 with no npm dependencies.

`node server.js` listens on the port in the PORT environment variable (default 3000) and keeps its data in the JSON file named by DATA_FILE (default `./todos.json`), so todos survive a restart.

Endpoints (all responses JSON):
- `POST /todos` with `{"title": string, "due"?: "YYYY-MM-DD"}` → 201 and the created todo `{"id", "title", "done": false, "due": string|null, "created_at": ISO timestamp}`. The title is stored trimmed and must be non-empty; `due`, when given, must be a real date in YYYY-MM-DD form. Invalid input → 400 `{"error": "..."}`.
- `GET /todos` → 200 with all todos ordered by id. `?done=true` / `?done=false` filters by status; `?overdue=true` returns only todos that are not done and whose due date is before today's date.
- `GET /todos/:id` → 200, or 404 `{"error": ...}` if there is no such todo.
- `PATCH /todos/:id` with any of `title`, `done`, `due` → 200 and the updated todo. Same validation as POST; `done` must be a boolean; `due` may be set to null. 404 if missing.
- `DELETE /todos/:id` → 204 with an empty body, or 404.
- Any other route → 404 JSON; a body that is not valid JSON → 400 JSON.

Ids are integers starting at 1 that are never reused, even after deletions and restarts.

Add a README with example curl commands.
