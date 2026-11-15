import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;

export interface SessionPayload {
  userId: string;
  exp: number;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) {
    return false;
  }
  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
    if (expectedBuf.length !== derived.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, derived);
  } catch {
    return false;
  }
}

export function signSessionToken(
  payload: SessionPayload,
  secret: string,
): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
): SessionPayload | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) {
    return null;
  }
  const data = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!data || !sig) {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(data, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SessionPayload).userId !== 'string' ||
      typeof (parsed as SessionPayload).exp !== 'number'
    ) {
      return null;
    }
    const session = parsed as SessionPayload;
    if (session.exp <= Date.now()) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}
