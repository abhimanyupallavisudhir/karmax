/**
 * Agent mailboxes' inbound edge (wiki features/agent-mail): a Cloudflare Email
 * Worker behind Email Routing's catch-all rule for the mail domain
 * (`agent-<token>@mail.<domain>`). There is no mail server and no inbox: each
 * message is posted, as raw MIME, to tavya's ingest webhook, signed with a
 * secret only this Worker and tavya hold, and tavya files it in the inbox of
 * the organization that owns the recipient (or drops it).
 *
 * It stores nothing. Mail for any other domain, or larger than tavya accepts,
 * is rejected during the SMTP conversation, so the sender gets a bounce rather
 * than silence. When tavya cannot take a message now, the handler throws and
 * the message is not accepted, rather than lost.
 *
 * Web-standard code only (no Node APIs): it runs in workerd, and in Node for tests.
 */
import { AGENT_MAIL_MAX_BYTES, MAIL_FROM_HEADER, MAIL_SIGNATURE_HEADER, MAIL_TO_HEADER, signMail } from './agent-mail-signature.js';

export interface MailEdgeEnv {
  /** tavya's webhook: `<public URL>/api/agent-mail/ingest`. */
  INGEST_URL: string;
  /** The only domain this Worker accepts mail for, e.g. mail.tavyausercontent.com. */
  MAIL_DOMAIN: string;
  /** A Worker secret: the signing key tavya derives from its auth secret. */
  INGEST_SECRET: string;
}

/** The parts of Cloudflare's ForwardableEmailMessage this Worker uses. */
export interface InboundEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export default {
  async email(message: InboundEmail, env: MailEdgeEnv): Promise<void> {
    const to = message.to.trim().toLowerCase();
    const from = message.from.trim().toLowerCase();
    if (!to.endsWith(`@${env.MAIL_DOMAIN.trim().toLowerCase()}`)) return message.setReject('No such mailbox here');
    if (message.rawSize > AGENT_MAIL_MAX_BYTES) return message.setReject('Message too large');
    const body = new Uint8Array(await new Response(message.raw).arrayBuffer());
    if (body.length > AGENT_MAIL_MAX_BYTES) return message.setReject('Message too large');
    const response = await fetch(env.INGEST_URL, { method: 'POST', body,
      headers: { 'content-type': 'message/rfc822', [MAIL_TO_HEADER]: to, [MAIL_FROM_HEADER]: from,
        [MAIL_SIGNATURE_HEADER]: await signMail(env.INGEST_SECRET, to, from, body) } });
    if (response.status === 413) return message.setReject('Message too large');
    if (!response.ok) throw new Error(`tavya did not take the message (${response.status})`);
  },
};
