/** Shared Temporal wiring constants. */
export const TASK_QUEUE = process.env.KARMAX_TASK_QUEUE?.trim() || 'karmax';

export interface TemporalConn {
  address: string;
  namespace: string;
  apiKey?: string;
  tls?: {
    serverNameOverride?: string;
    serverRootCACertificate?: Buffer;
    clientCertPair?: { crt: Buffer; key: Buffer };
  };
}
