This is a small to-do REST API (Node.js 22, no dependencies; see README.md). It currently has no users: everyone shares one list. Please add user accounts:

- `POST /signup` with `{"username", "password"}` → 201 `{"id", "username"}`. Usernames are 3–20 characters of lowercase letters, digits or `_`; passwords at least 8 characters; otherwise 400 `{"error"}`. A taken username → 409.
- `POST /login` with the same body → 200 `{"token": "..."}`; wrong username or password → 401.
- `POST /logout` with the token → 204, after which that token no longer works.
- Every `/todos` endpoint now requires `Authorization: Bearer <token>` (missing or invalid → 401 `{"error"}`), and each user only sees and changes their own todos: another user's todo id behaves exactly like one that does not exist (404). Everything else about the todo endpoints stays as it is.
- Passwords must never be stored in plain text — use a proper password hash (Node's built-in `crypto.scrypt` is fine). Users, tokens and todos are all kept in the DATA_FILE, so they survive a restart.

Keep the existing tests passing, add tests for the new behaviour, and update the README.
