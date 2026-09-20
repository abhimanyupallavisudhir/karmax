import fs from 'node:fs';

let stopped = false;
let reads = 0;
const errors = [];
function read() {
  try {
    const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    if (value.payload !== 'x'.repeat(256 * 1024) || !value.mcpServers) throw new Error('incomplete config');
    reads++;
  } catch (error) { errors.push(error.message); }
}
function loop() { if (!stopped) { read(); setImmediate(loop); } }
process.on('message', () => {
  stopped = true;
  read();
  process.send({ reads, errors }, () => process.disconnect());
});
process.send('ready');
loop();
