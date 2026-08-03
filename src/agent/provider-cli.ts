import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Resolve the provider executables Karmax ships in its production dependencies.
 * Falling back to the command name preserves globally installed CLIs for source
 * checkouts whose dependencies have not been installed yet.
 */
export function localProviderCli(provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? claudeSdkExecutable() ?? 'claude' : packageBin('@openai/codex', 'codex') ?? 'codex';
}

function packageBin(packageName: string, binName: string): string | undefined {
  try {
    const packageFile = require.resolve(`${packageName}/package.json`);
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const relative = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[binName];
    if (!relative) return undefined;
    const executable = path.resolve(path.dirname(packageFile), relative);
    return fs.existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/** The Agent SDK already ships the exact Claude Code binary it is paired with. */
function claudeSdkExecutable(): string | undefined {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : process.platform;
  const base = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}`;
  const preferred = process.platform === 'linux' && usesMusl() ? `${base}-musl` : base;
  const candidates = process.platform === 'linux' ? [preferred, preferred === base ? `${base}-musl` : base] : [preferred];
  for (const packageName of candidates) {
    try {
      const packageFile = require.resolve(`${packageName}/package.json`);
      const executable = path.join(path.dirname(packageFile), process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(executable)) return executable;
    } catch {
      /* Try the other libc build, then the global command fallback. */
    }
  }
  return undefined;
}

function usesMusl(): boolean {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}
