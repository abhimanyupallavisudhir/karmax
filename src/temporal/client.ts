import { Client, Connection } from '@temporalio/client';
import { TemporalConn } from './config.js';

/** gRPC's 4 MiB default is smaller than one page of an ordinary history: a
 * page of turns with their conversation carried 6.3 MB on tavya.io, so every
 * history read (the replay gates, fetchHistory) failed with RESOURCE_EXHAUSTED.
 * Temporal caps a whole history at 50 MB. */
const MAX_RECEIVE_BYTES = 64 * 1024 * 1024;

export async function makeClient(conn: TemporalConn): Promise<{ client: Client; close(): Promise<void> }> {
  const connection = await Connection.connect({ address: conn.address, apiKey: conn.apiKey, tls: conn.tls,
    channelArgs: { 'grpc.max_receive_message_length': MAX_RECEIVE_BYTES } });
  const client = new Client({ connection, namespace: conn.namespace });
  return {
    client,
    async close() {
      await connection.close();
    },
  };
}
