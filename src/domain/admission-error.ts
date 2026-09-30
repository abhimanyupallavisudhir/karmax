/** Temporary organization capacity pressure, unrelated to provider login health. */
export class AdmissionBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionBackpressureError';
  }
}
