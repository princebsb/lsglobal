import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { env } from '../config/env';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Criptografia de aplicação:
 * - Argon2id para senhas (parâmetros OWASP);
 * - AES-256-GCM para dados pessoais sensíveis (CPF/CNPJ, segredo MFA);
 * - HMAC-SHA256 para índice cego (busca/deduplicação sem expor o dado);
 * - TOTP (RFC 6238) para MFA, sem dependência externa.
 */
@Injectable()
export class CryptoService {
  private readonly encKey = Buffer.from(env().DATA_ENCRYPTION_KEY, 'base64');
  private readonly hmacKey = Buffer.from(env().DATA_HMAC_KEY, 'base64');

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
  }

  decrypt(payload: string): string {
    const [v, iv, tag, data] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Formato de cifra inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex');
  }

  sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

  // ------------------------------------------------------------------ TOTP
  generateTotpSecret(): string {
    const bytes = randomBytes(20);
    let bits = '';
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
    return out;
  }

  totpUri(secret: string, account: string, issuer = 'LS Global Assembleias'): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  }

  totpCode(secret: string, atMs = Date.now()): string {
    return this.hotp(secret, Math.floor(atMs / 1000 / 30));
  }

  verifyTotp(secret: string, code: string, window = 1, atMs = Date.now()): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    const counter = Math.floor(atMs / 1000 / 30);
    for (let w = -window; w <= window; w++) {
      if (this.safeEqual(this.hotp(secret, counter + w), code)) return true;
    }
    return false;
  }

  private hotp(secret: string, counter: number): string {
    const key = this.base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const h = createHmac('sha1', key).update(buf).digest();
    const offset = h[h.length - 1]! & 0x0f;
    const bin =
      ((h[offset]! & 0x7f) << 24) | ((h[offset + 1]! & 0xff) << 16) | ((h[offset + 2]! & 0xff) << 8) | (h[offset + 3]! & 0xff);
    return (bin % 1_000_000).toString().padStart(6, '0');
  }

  private base32Decode(input: string): Buffer {
    const clean = input.replace(/=+$/, '').toUpperCase();
    let bits = '';
    for (const c of clean) {
      const v = B32.indexOf(c);
      if (v < 0) throw new Error('Base32 inválido');
      bits += v.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
  }
}
