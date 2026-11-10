import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Cabeçalhos de rastreio (sem dados pessoais). */
  headers?: Record<string, string>;
}

export interface MailResult {
  messageId: string;
  /** Caminho do .eml gravado (driver "file"). */
  file?: string;
}

/**
 * Envio de e-mail.
 * - driver "file" (padrão em desenvolvimento): grava a mensagem completa (.eml) em MAIL_OUTBOX_DIR,
 *   sem enviar nada para fora da máquina;
 * - driver "smtp": envia por SMTP (SMTP_URL, ex.: smtps://usuario:senha@smtp.provedor.com:465).
 *
 * "Enviado" significa ACEITO pelo servidor SMTP/arquivo — não garante entrega na caixa do destinatário.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter?: Transporter;

  private get(): Transporter {
    if (this.transporter) return this.transporter;
    const e = env();
    this.transporter =
      e.MAIL_DRIVER === 'smtp'
        ? nodemailer.createTransport(e.SMTP_URL!)
        : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    return this.transporter;
  }

  async send(msg: MailMessage): Promise<MailResult> {
    const e = env();
    const info = await this.get().sendMail({
      from: e.MAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
    });
    const messageId = String(info.messageId ?? '').replace(/[<>]/g, '');
    if (e.MAIL_DRIVER === 'file') {
      const dir = resolve(e.MAIL_OUTBOX_DIR);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${messageId.replace(/[^\w.-]/g, '_')}.eml`);
      await writeFile(file, (info as unknown as { message: Buffer }).message);
      this.logger.debug(`E-mail gravado em ${file}`);
      return { messageId, file };
    }
    return { messageId };
  }
}
