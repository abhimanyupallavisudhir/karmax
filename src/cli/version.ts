import pkg from '../../cli/package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
