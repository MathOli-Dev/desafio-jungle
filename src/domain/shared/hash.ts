import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves ordenadas lexicograficamente em todos os níveis, sem espaços,
 * `undefined` omitido em objetos (e `null` em arrays). Mesmo conteúdo ⇒ mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: non-finite number');
    }
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** sha256(canonicalJson(value)) em hexadecimal (64 chars). */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
