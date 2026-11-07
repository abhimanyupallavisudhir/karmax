'use strict';

const http = require('node:http');
const fs = require('node:fs');

const port = process.env.PORT ?? 3000;
const dataFile = process.env.DATA_FILE ?? './todos.json';

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!data || !Array.isArray(data.todos) || !Number.isSafeInteger(data.nextId) ||
        data.nextId < 1 || data.todos.some(todo => !Number.isSafeInteger(todo.id) || todo.id < 1 || todo.id >= data.nextId)) {
      throw new Error('Invalid todo data');
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { nextId: 1, todos: [] };
    throw error;
  }
}

let data = loadData();

function saveData(nextData) {
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(nextData, null, 2) + '\n');
    fs.renameSync(tempFile, dataFile);
    data = nextData;
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}

function send(res, status, value) {
  if (status === 204) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validate(body, isPatch) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object';
  const has = key => Object.hasOwn(body, key);
  if (!isPatch || has('title')) {
    if (typeof body.title !== 'string' || !body.title.trim()) return 'title must be a non-empty string';
  }
  if (has('due') && !(isPatch && body.due === null) && !validDate(body.due)) {
    return 'due must be a real date in YYYY-MM-DD form' + (isPatch ? ' or null' : '');
  }
  if (isPatch && has('done') && typeof body.done !== 'boolean') return 'done must be a boolean';
  if (isPatch && !has('title') && !has('done') && !has('due')) return 'Expected at least one of title, done, or due';
  return null;
}

function handle(req, res, body) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/todos' && req.method === 'GET') {
    let todos = data.todos.slice().sort((a, b) => a.id - b.id);
    const done = url.searchParams.get('done');
    if (done === 'true' || done === 'false') todos = todos.filter(todo => todo.done === (done === 'true'));
    if (url.searchParams.get('overdue') === 'true') {
      const today = new Date().toISOString().slice(0, 10);
      todos = todos.filter(todo => !todo.done && todo.due !== null && todo.due < today);
    }
    return send(res, 200, todos);
  }

  if (path === '/todos' && req.method === 'POST') {
    const error = validate(body, false);
    if (error) return send(res, 400, { error });
    if (!Number.isSafeInteger(data.nextId + 1)) throw new Error('No more todo IDs available');
    const todo = {
      id: data.nextId,
      title: body.title.trim(),
      done: false,
      due: Object.hasOwn(body, 'due') ? body.due : null,
      created_at: new Date().toISOString(),
    };
    saveData({ nextId: data.nextId + 1, todos: [...data.todos, todo] });
    return send(res, 201, todo);
  }

  const match = /^\/todos\/(\d+)$/.exec(path);
  if (match && ['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    const id = Number(match[1]);
    const index = data.todos.findIndex(todo => todo.id === id);
    if (index === -1) return send(res, 404, { error: 'Todo not found' });
    if (req.method === 'GET') return send(res, 200, data.todos[index]);
    if (req.method === 'DELETE') {
      saveData({ ...data, todos: data.todos.filter(todo => todo.id !== id) });
      return send(res, 204);
    }
    const error = validate(body, true);
    if (error) return send(res, 400, { error });
    const todo = { ...data.todos[index] };
    if (Object.hasOwn(body, 'title')) todo.title = body.title.trim();
    if (Object.hasOwn(body, 'done')) todo.done = body.done;
    if (Object.hasOwn(body, 'due')) todo.due = body.due;
    const todos = data.todos.slice();
    todos[index] = todo;
    saveData({ ...data, todos });
    return send(res, 200, todo);
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body;
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'Invalid JSON' });
      }
    }
    try {
      handle(req, res, body);
    } catch (error) {
      console.error(error);
      send(res, 500, { error: 'Internal server error' });
    }
  });
});
server.listen(port, () => console.log(`Listening on port ${server.address().port}`));
