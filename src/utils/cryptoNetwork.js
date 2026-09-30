const { isAddress: isEvmAddress, ZeroAddress } = require('ethers');
const bs58 = require('bs58');
const { ed25519 } = require('@noble/curves/ed25519');
const { isTronAddress } = require('./tron');

const NETWORKS = Object.freeze({
  TRC20: Object.freeze({
    code: 'TRC20',
    label: 'TRC20',
    addressSetting: 'deposit_address_trc20',
    addressPlaceholder: 'T...',
    explorerTxBase: 'https://tronscan.org/#/transaction/',
    explorerAddressBase: 'https://tronscan.org/#/address/',
  }),
  BEP20: Object.freeze({
    code: 'BEP20',
    label: 'BEP20',
    addressSetting: 'deposit_address_bep20',
    addressPlaceholder: '0x...',
    explorerTxBase: 'https://bscscan.com/tx/',
    explorerAddressBase: 'https://bscscan.com/address/',
  }),
  SPL: Object.freeze({
    code: 'SPL',
    label: 'Solana/SPL',
    addressSetting: 'deposit_address_spl',
    addressPlaceholder: 'Solana wallet address',
    explorerTxBase: 'https://solscan.io/tx/',
    explorerAddressBase: 'https://solscan.io/account/',
  }),
});

const LEGACY_NETWORKS = Object.freeze({
  'TRC-20': 'TRC20',
  TRON: 'TRC20',
  'BEP-20': 'BEP20',
  BSC: 'BEP20',
  SOLANA: 'SPL',
});

function normalizeNetwork(value) {
  const raw = String(value || '').trim().toUpperCase();
  const code = LEGACY_NETWORKS[raw] || raw;
  return NETWORKS[code] ? code : null;
}

function requireNetwork(value) {
  const code = normalizeNetwork(value);
  if (!code) throw new Error('unsupported crypto network');
  return code;
}

function isSolanaWalletAddress(address) {
  try {
    const bytes = bs58.decode(address);
    if (bytes.length !== 32 || bs58.encode(bytes) !== address) return false;
    // A member payout wallet must be an Ed25519 public key controlled by a
    // private key, not an off-curve program-derived address.
    ed25519.Point.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function isValidAddress(address, network) {
  const value = typeof address === 'string' ? address.trim() : '';
  if (!value) return false;

  const code = normalizeNetwork(network);
  if (code === 'TRC20') return isTronAddress(value);
  if (code === 'BEP20') return isEvmAddress(value) && value.toLowerCase() !== ZeroAddress;
  if (code === 'SPL') return isSolanaWalletAddress(value);
  return false;
}

function activeNetwork(settings) {
  return normalizeNetwork(settings.active_crypto_network || settings.deposit_network) || 'TRC20';
}

function depositAddress(settings, network = activeNetwork(settings)) {
  const code = requireNetwork(network);
  const current = String(settings[NETWORKS[code].addressSetting] || '').trim();
  if (current) return current;
  // Backward compatibility while migration 009 is being deployed.
  if (code === 'TRC20') return String(settings.admin_deposit_address || '').trim();
  return '';
}

function publicNetwork(settings) {
  const code = activeNetwork(settings);
  const meta = NETWORKS[code];
  return {
    code,
    label: meta.label,
    address: depositAddress(settings, code),
    address_placeholder: meta.addressPlaceholder,
    explorer_tx_base: meta.explorerTxBase,
    explorer_address_base: meta.explorerAddressBase,
  };
}

module.exports = {
  NETWORKS,
  normalizeNetwork,
  requireNetwork,
  isValidAddress,
  activeNetwork,
  depositAddress,
  publicNetwork,
};
