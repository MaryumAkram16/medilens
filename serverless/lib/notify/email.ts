/**
 * Email behind an interface so the provider can be swapped. SMTP (Gmail app
 * password) in production; without SMTP settings, emails are logged instead.
 */
import nodemailer from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  readonly kind: 'smtp' | 'log';
  send(email: Email): Promise<void>;
}

export class LogEmailSender implements EmailSender {
  readonly kind = 'log' as const;
  readonly sent: Email[] = [];
  async send(email: Email): Promise<void> {
    this.sent.push(email);
    // Recipient domain and subject only: patient details stay out of logs.
    console.log(JSON.stringify({ level: 'info', msg: 'email_logged', to_domain: email.to.split('@')[1] ?? '', subject: email.subject }));
  }
}

export class SmtpEmailSender implements EmailSender {
  readonly kind = 'smtp' as const;
  private readonly transport;

  constructor(
    private readonly opts: { user: string; appPassword: string; from?: string },
  ) {
    this.transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: opts.user, pass: opts.appPassword },
      connectionTimeout: 8_000,
      socketTimeout: 8_000,
    });
  }

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({ from: this.opts.from || this.opts.user, ...email });
  }
}
