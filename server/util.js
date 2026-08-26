import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newId(prefix = 'id', len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Hash de senha com scrypt (sal por usuário). */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [alg, salt, hex] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hex) return false;
  const derived = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  const a = Buffer.from(hex, 'hex');
  return a.length === derived.length && crypto.timingSafeEqual(a, derived);
}

/** Igualdade em tempo constante para tokens. */
export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = (v) => Math.round(v * 10) / 10;

/** Casa tópicos no estilo MQTT: `+` = um nível, `#` = resto. */
export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] === '+') continue;
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export function nowIso() {
  return new Date().toISOString();
}
