import path from 'node:path';

export function isRecordedTemporalProcess(record: { pid?: number; address?: string }, argv: string[]): boolean {
  if (!Number.isSafeInteger(record.pid) || !record.address) return false;
  const port = /^127\.0\.0\.1:(\d+)$/.exec(record.address)?.[1];
  if (!port || !/^(?:temporal|temporal\.exe)$/.test(path.basename(argv[0] ?? ''))) return false;
  if (argv[1] !== 'server' || argv[2] !== 'start-dev') return false;
  const portArg = argv.indexOf('--port');
  return portArg >= 0 && argv[portArg + 1] === port;
}
