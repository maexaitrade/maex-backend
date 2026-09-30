const { isValidAddress, normalizeNetwork, activeNetwork } = require('../src/utils/cryptoNetwork');

describe('crypto network address validation', () => {
  test('normalizes supported network aliases', () => {
    expect(normalizeNetwork('TRC-20')).toBe('TRC20');
    expect(normalizeNetwork('bep-20')).toBe('BEP20');
    expect(normalizeNetwork('solana')).toBe('SPL');
    expect(normalizeNetwork('unknown')).toBeNull();
  });

  test('validates addresses only against the selected network', () => {
    const tron = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const evm = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
    const solana = '5oNDL3swdJJF1g9DzJiZ4ynHXgszjAEpUkxVYejchzrY';

    expect(isValidAddress(tron, 'TRC20')).toBe(true);
    expect(isValidAddress(tron, 'BEP20')).toBe(false);
    expect(isValidAddress(evm, 'BEP20')).toBe(true);
    expect(isValidAddress(evm, 'SPL')).toBe(false);
    expect(isValidAddress(solana, 'SPL')).toBe(true);
    expect(isValidAddress(solana, 'TRC20')).toBe(false);
  });

  test('uses one active network value', () => {
    expect(activeNetwork({ active_crypto_network: 'BEP20', deposit_network: 'TRC-20' })).toBe('BEP20');
    expect(activeNetwork({ deposit_network: 'TRC-20' })).toBe('TRC20');
  });
});
