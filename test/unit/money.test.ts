import { describe, expect, test } from 'bun:test';
import { Money } from '@/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/shared/errors';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Money — parse e escala', () => {
  test.each([
    ['25', '25.00'], ['25.5', '25.50'], ['25.50', '25.50'], ['0', '0.00'], ['0.05', '0.05'],
    ['1000.00', '1000.00'], ['99999999999999999.99', '99999999999999999.99'],
  ])('normaliza %p para escala fixa de 2 casas (%p)', (input, expected) => {
    expect(m(input).amount).toBe(expected);
    expect(m(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    '', ' ', ' 1.00', '1.00 ', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '0x10', '-1.00', '-0.00', '+1.00',
    '1,00', '1.', '.5', '007.00', '1 000', '１２', 'abc', '1.001', '10.999', '0.005', '1..0',
  ])('rejeita entrada inválida %p (sem arredondar)', (input) => {
    expect(() => m(input)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não seja string (number nunca é aceito para dinheiro)', () => {
    for (const amount of [25, 25.5, null, undefined, {}, [], true]) {
      expect(() => Money.from({ amount, currency: 'BRL' } as never)).toThrow(InvalidMoneyError);
    }
  });

  test('rejeita payload que não seja objeto', () => {
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
    expect(() => Money.from('25.00' as never)).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L', ' BRL'])('rejeita moeda inválida %p', (currency) => {
    expect(() => m('1.00', currency)).toThrow(InvalidMoneyError);
  });
  test('rejeita moeda não-string', () => {
    expect(() => Money.from({ amount: '1.00', currency: 1 } as never)).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata e imutabilidade', () => {
  test('0.10 + 0.20 === 0.30 (sem erro de ponto flutuante)', () => {
    expect(m('0.10').add(m('0.20')).equals(m('0.30'))).toBe(true);
    expect(m('0.10').add(m('0.20')).amount).toBe('0.30');
  });

  test('soma/subtração em valores grandes permanecem exatas', () => {
    expect(m('99999999999999999.98').add(m('0.01')).amount).toBe('99999999999999999.99');
    expect(m('1000000000000.01').subtract(m('0.02')).amount).toBe('999999999999.99');
  });

  test('estouro do limite de numeric(19,2) é rejeitado', () => {
    expect(() => m('99999999999999999.99').add(m('0.01'))).toThrow(InvalidMoneyError);
  });

  test('subtract pode ficar negativo; negate/isNegative/isPositive/isZero', () => {
    const r = m('10.00').subtract(m('25.50'));
    expect(r.isNegative()).toBe(true);
    expect(r.amount).toBe('-15.50');
    expect(r.negate().amount).toBe('15.50');
    expect(r.negate().isPositive()).toBe(true);
    expect(m('0.00').isZero()).toBe(true);
    expect(m('0.00').isPositive()).toBe(false);
    expect(m('0.00').negate().isNegative()).toBe(false);
  });

  test('isLessThan / equals', () => {
    expect(m('9.99').isLessThan(m('10.00'))).toBe(true);
    expect(m('10.00').isLessThan(m('10.00'))).toBe(false);
    expect(m('10').equals(m('10.00'))).toBe(true);
  });

  test('é imutável: operações retornam novas instâncias e o objeto é congelado', () => {
    const a = m('10.00');
    const b = a.add(m('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });

  test('toJSON e toString', () => {
    expect(JSON.stringify(m('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(m('25.00').toString()).toBe('25.00 BRL');
  });
});

describe('Money — conflito de moeda', () => {
  test('add/subtract/isLessThan entre moedas diferentes lançam erro de domínio', () => {
    const brl = m('10.00', 'BRL');
    const usd = m('10.00', 'USD');
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
  test('equals entre moedas diferentes é false (não lança)', () => {
    expect(m('10.00', 'BRL').equals(m('10.00', 'USD'))).toBe(false);
  });
  test('zero(currency) respeita a moeda', () => {
    expect(Money.zero('USD').currency).toBe('USD');
    expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
  });
});
