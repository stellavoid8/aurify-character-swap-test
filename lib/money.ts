/**
 * Money is an integer number of micro-dollars (1 = $0.000001) everywhere it is stored or summed.
 * Per-call model costs ($0.001–$0.04) would round to zero in cents. Format only through here.
 */

const MICROS_PER_USD = 1_000_000;

/** `$0.039` below $1 (three decimals), `$1.25` from $1 up. Non-zero amounts under $0.0005 show as `<$0.001`. */
export function formatUsd(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(Math.round(micros));
  const mills = Math.round(abs / 1000);
  if (mills < 1000) {
    if (abs > 0 && mills === 0) return `${sign}<$0.001`;
    return `${sign}$0.${String(mills).padStart(3, '0')}`;
  }
  const cents = Math.round(abs / 10_000);
  const dollars = Math.floor(cents / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

/** Token usage priced in USD per million tokens. Since 1 USD = 1e6 micros, micros = tokens × price. */
export function microsFromTokens({
  inputTokens,
  outputTokens,
  inPerMTokUsd,
  outPerMTokUsd,
}: {
  inputTokens: number;
  outputTokens: number;
  inPerMTokUsd: number;
  outPerMTokUsd: number;
}): number {
  return Math.round(inputTokens * inPerMTokUsd + outputTokens * outPerMTokUsd);
}

/** Sums integer micros; null/undefined (unknown cost) count as 0. */
export function sumMicros(...values: (number | null | undefined)[]): number {
  return values.reduce<number>((total, value) => total + Math.round(value ?? 0), 0);
}

export function microsFromUsd(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}
