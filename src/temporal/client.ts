import { Client, Connection } from '@temporalio/client';
import { TemporalConn } from './config.js';

export async function makeClient(conn: TemporalConn): Promise<{ client: Client; close(): Promise<void> }> {
  const connection = await Connection.connect({ address: conn.address });
  const client = new Client({ connection, namespace: conn.namespace });
  return {
    client,
    async close() {
      await connection.close();
    },
  };
}
