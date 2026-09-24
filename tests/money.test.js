const { round2, toCents, fromCents, percentOf } = require('../src/utils/money');

describe('money utils', () => {
  test('round2 avoids float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(19.999)).toBe(20);
  });

  test('toCents / fromCents round-trip', () => {
    expect(toCents(12.34)).toBe(1234);
    expect(fromCents(1234)).toBe(12.34);
  });

  test('percentOf matches the plan figures', () => {
    expect(percentOf(1000, 1)).toBe(10); // 1% daily ROI on $1000
    expect(percentOf(1000, 3)).toBe(30); // L1 referral
    expect(percentOf(1000, 1.5)).toBe(15); // L2 / L3 referral
    expect(percentOf(1000, 20)).toBe(200); // booster
    expect(percentOf(50, 6)).toBe(3); // withdrawal charge
  });
});
