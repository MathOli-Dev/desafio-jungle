import { CurrencyMismatchError, InvalidMoneyError } from '../shared/errors';

/** DTO de contrato: `amount` é SEMPRE string decimal com escala fixa de 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Inteiro sem zeros à esquerda (≤17 dígitos) + fração opcional de 1–2 dígitos. Sem sinal, expoente, NaN, Infinity. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Limite de numeric(19,2): 17 dígitos inteiros + 2 decimais, em centavos. */
const MAX_ABS_CENTS = 10n ** 19n - 1n;

/**
 * Valor monetário imutável. Representação interna: centavos em `bigint` (exata, sem float/number).
 * O domínio não depende de ORM nem de Nest.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parse estrito de contrato de entrada (rejeita negativos). Normaliza para escala 2. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object { amount, currency }');
    }
    const { amount, currency } = props as { amount: unknown; currency: unknown };
    Money.assertCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string', { received: typeof amount });
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with at most 2 fraction digits (e.g. "25.00")',
        { amount: amount.slice(0, 32) },
      );
    }
    const [int, frac = ''] = amount.split('.') as [string, string?];
    return new Money(BigInt(int + frac.padEnd(2, '0')), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 alpha-3 code in upper case', {
        currency: typeof currency === 'string' ? currency.slice(0, 8) : typeof currency,
      });
    }
  }

  private static ofCents(cents: bigint, currency: string): Money {
    if (cents > MAX_ABS_CENTS || cents < -MAX_ABS_CENTS) {
      throw new InvalidMoneyError('monetary value out of supported range');
    }
    return new Money(cents, currency);
  }

  /** "25.00" (escala 2). Pode ter sinal apenas em resultados intermediários (subtract/negate). */
  get amount(): string {
    const negative = this.cents < 0n;
    const digits = (negative ? -this.cents : this.cents).toString().padStart(3, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.ofCents(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /** Igualdade de valor *e* moeda. Moedas diferentes ⇒ `false` (comparar é seguro; aritmética é que lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`, {
        left: this.currency,
        right: other.currency,
      });
    }
  }
}
