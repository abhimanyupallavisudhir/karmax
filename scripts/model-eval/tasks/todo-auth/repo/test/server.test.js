'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const serverFile = path.join(__dirname, '..', 'server.js');

async function start(dataFile) {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: '0', DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [output] = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited with code ${code}`); }),
  ]);
  const match = /Listening on port (\d+)/.exec(output.toString());
  assert.ok(match, `Unexpected server output: ${output}`);
  return { child, url: `http://127.0.0.1:${match[1]}` };
}

async function stop(server) {
  if (server && server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill();
    await once(server.child, 'exit');
  }
}

async function request(server, route, method = 'GET', body) {
  const response = await fetch(server.url + route, {
    method,
    ...(body !== undefined ? { body, headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

test('todo API validates, filters, persists, and never reuses IDs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-api-'));
  const dataFile = path.join(dir, 'data.json');
  let server;
  t.after(async () => {
    await stop(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server = await start(dataFile);

  for (const body of ['{', 'null', '[]', '{}', '{"title":"  "}', '{"title":3}',
    '{"title":"test","due":null}', '{"title":"test","due":"2025-02-29"}',
    '{"title":"test","due":"2024-2-29"}']) {
    const response = await request(server, '/todos', 'POST', body);
    assert.equal(response.status, 400, body);
    assert.equal(typeof response.body.error, 'string');
  }

  const created = await request(server, '/todos', 'POST', '{"title":"  First  ","due":"2024-02-29"}');
  assert.equal(created.status, 201);
  assert.deepEqual({ ...created.body, created_at: undefined }, {
    id: 1, title: 'First', done: false, due: '2024-02-29', created_at: undefined,
  });
  assert.equal(new Date(created.body.created_at).toISOString(), created.body.created_at);

  const second = await request(server, '/todos', 'POST', '{"title":"Second"}');
  assert.equal(second.body.id, 2);
  assert.equal(second.body.due, null);
  assert.deepEqual((await request(server, '/todos/1')).body, created.body);

  for (const body of ['{}', '{"title":" "}', '{"done":"true"}', '{"due":"2023-02-29"}']) {
    assert.equal((await request(server, '/todos/1', 'PATCH', body)).status, 400, body);
  }
  const updated = await request(server, '/todos/2', 'PATCH', '{"title":"  Updated  ","done":true,"due":"2000-01-01"}');
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, 'Updated');
  assert.equal(updated.body.done, true);
  assert.equal(updated.body.due, '2000-01-01');
  assert.equal(updated.body.created_at, second.body.created_at);

  assert.deepEqual((await request(server, '/todos')).body.map(todo => todo.id), [1, 2]);
  assert.deepEqual((await request(server, '/todos?done=true')).body.map(todo => todo.id), [2]);
  assert.deepEqual((await request(server, '/todos?done=false')).body.map(todo => todo.id), [1]);
  assert.deepEqual((await request(server, '/todos?overdue=true')).body.map(todo => todo.id), [1]);
  assert.deepEqual((await request(server, '/todos?overdue=true&done=true')).body, []);
  assert.equal((await request(server, '/todos/1', 'PATCH', '{"due":null}')).body.due, null);
  assert.deepEqual((await request(server, '/todos?overdue=true')).body, []);

  const deleted = await request(server, '/todos/2', 'DELETE');
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, '');
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const response = await request(server, '/todos/2', method, method === 'PATCH' ? '{"done":false}' : undefined);
    assert.equal(response.status, 404);
    assert.equal(typeof response.body.error, 'string');
  }
  assert.equal((await request(server, '/other')).status, 404);
  assert.equal((await request(server, '/other', 'POST', '{')).status, 400);

  await stop(server);
  server = await start(dataFile);
  assert.deepEqual((await request(server, '/todos')).body.map(todo => todo.id), [1]);
  assert.equal((await request(server, '/todos/1')).body.due, null);
  const third = await request(server, '/todos', 'POST', '{"title":"Third"}');
  assert.equal(third.body.id, 3);
  await request(server, '/todos/1', 'DELETE');
  await request(server, '/todos/3', 'DELETE');
  await stop(server);
  server = await start(dataFile);
  assert.deepEqual((await request(server, '/todos')).body, []);
  assert.equal((await request(server, '/todos', 'POST', '{"title":"Fourth"}')).body.id, 4);
});
