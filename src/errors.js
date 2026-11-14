export class PrivacyCountError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrivacyCountError';
    this.code = code;
    this.details = details;
  }
}
