import fs from 'node:fs';

// Keep Node-only TLS file loading outside the workflow-safe config module.
export function temporalConnectionFromEnv(): import('./config.js').TemporalConn | undefined {
  const address = process.env.KARMAX_TEMPORAL_ADDRESS?.trim();
  if (!address) return undefined;
  const read = (name: string) => process.env[name]?.trim() ? fs.readFileSync(process.env[name]!.trim()) : undefined;
  const ca = read('KARMAX_TEMPORAL_TLS_CA');
  const crt = read('KARMAX_TEMPORAL_TLS_CERT');
  const key = read('KARMAX_TEMPORAL_TLS_KEY');
  if (Boolean(crt) !== Boolean(key)) throw new Error('KARMAX_TEMPORAL_TLS_CERT and KARMAX_TEMPORAL_TLS_KEY must be set together');
  const tls = ca || crt || process.env.KARMAX_TEMPORAL_TLS_SERVER_NAME
    ? { ...(ca ? { serverRootCACertificate: ca } : {}), ...(crt && key ? { clientCertPair: { crt, key } } : {}),
        ...(process.env.KARMAX_TEMPORAL_TLS_SERVER_NAME ? { serverNameOverride: process.env.KARMAX_TEMPORAL_TLS_SERVER_NAME } : {}) }
    : process.env.KARMAX_TEMPORAL_API_KEY ? {} : undefined;
  return { address, namespace: process.env.KARMAX_TEMPORAL_NAMESPACE?.trim() || 'default',
    ...(process.env.KARMAX_TEMPORAL_API_KEY ? { apiKey: process.env.KARMAX_TEMPORAL_API_KEY } : {}), ...(tls ? { tls } : {}) };
}
