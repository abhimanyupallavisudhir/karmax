/**
 * Minimal ambient declaration for nodemailer (which ships no bundled types and
 * we don't pull @types for). Covers only the transport + sendMail surface
 * `src/autonomy/email.ts` uses.
 */
declare module 'nodemailer' {
  interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user?: string; pass?: string };
  }
  interface SendMailOptions {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    html?: string;
  }
  interface Transporter {
    sendMail(options: SendMailOptions): Promise<unknown>;
  }
  interface Nodemailer {
    createTransport(options: TransportOptions): Transporter;
  }
  const nodemailer: Nodemailer;
  export default nodemailer;
}
