// A worker child from before heartbeats carried its heap: it answers every
// control request with the original reply shape and nothing else.
process.on('message', (request) => {
  if (request?.type !== 'worker.request') return;
  process.send({ type: 'worker.reply', id: request.id, ok: true });
  if (request.action === 'stop') setTimeout(() => process.exit(0), 10);
});
process.on('disconnect', () => process.exit(0));
