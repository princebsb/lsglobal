/**
 * Aritmética decimal exata em ponto fixo (BigInt) para frações ideais e pesos de voto.
 *
 * Frações ideais são armazenadas no PostgreSQL como numeric(14,10). Para não introduzir
 * erros de arredondamento de ponto flutuante em apurações jurídicas, todos os cálculos
 * de quórum são feitos com inteiros escalados por 10^10.
 */
export const FIXED_DIGITS = 10;
export const FIXED_SCALE = 10n ** BigInt(FIXED_DIGITS);

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$|^\.(\d+)$/;

/** Converte "0.0833333333" → 833333333n (escala 10^10). Rejeita negativos e mais de 10 casas significativas. */
export function parseFixed(value: string | number): bigint {
  const str = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const m = DECIMAL_RE.exec(str);
  if (!m) throw new RangeError(`Valor decimal inválido: "${str}"`);
  const intPart = m[1] ?? '0';
  let frac = m[2] ?? m[3] ?? '';
  // remove zeros à direita que excedam a escala, sem perder precisão significativa
  if (frac.length > FIXED_DIGITS) {
    const extra = frac.slice(FIXED_DIGITS);
    if (/[^0]/.test(extra)) {
      throw new RangeError(`Valor "${str}" excede ${FIXED_DIGITS} casas decimais`);
    }
    frac = frac.slice(0, FIXED_DIGITS);
  }
  frac = frac.padEnd(FIXED_DIGITS, '0');
  return BigInt(intPart) * FIXED_SCALE + BigInt(frac);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Número inválido: ${n}`);
  return n.toFixed(FIXED_DIGITS);
}

/** 833333333n → "0.0833333333" (sem zeros à direita desnecessários). */
export function formatFixed(value: bigint, digits = FIXED_DIGITS): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / FIXED_SCALE;
  let frac = (abs % FIXED_SCALE).toString().padStart(FIXED_DIGITS, '0');
  if (digits < FIXED_DIGITS) frac = frac.slice(0, digits);
  frac = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart.toString()}${frac ? '.' + frac : ''}`;
}

/** Percentual com 4 casas, truncado (somente para exibição; nunca usado em decisões). */
export function ratioToPercent(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return '0';
  const scaled = (numerator * 100n * 10000n) / denominator;
  const intPart = scaled / 10000n;
  const frac = (scaled % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${intPart}${frac ? '.' + frac : ''}`;
}

/** Soma uma lista de valores em ponto fixo. */
export function sumFixed(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Divisão inteira com arredondamento para cima (valores não negativos). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('Divisor deve ser positivo');
  return (a + b - 1n) / b;
}
