/**
 * HyperLiquid HIP-4 Constants
 */

export const HL_API = {
  TESTNET_INFO: 'https://api.hyperliquid-testnet.xyz/info',
  TESTNET_EXCHANGE: 'https://api.hyperliquid-testnet.xyz/exchange',
  MAINNET_INFO: 'https://api.hyperliquid.xyz/info',
  MAINNET_EXCHANGE: 'https://api.hyperliquid.xyz/exchange',
  TESTNET_WS: 'wss://api.hyperliquid-testnet.xyz/ws',
  MAINNET_WS: 'wss://api.hyperliquid.xyz/ws',
};

export const NETWORK = {
  TESTNET: 'testnet',
  MAINNET: 'mainnet',
};

// Asset encoding constants
export const OUTCOME_ASSET_BASE = 100_000_000;
export const OUTCOME_SIDE_YES = 0;
export const OUTCOME_SIDE_NO = 1;

// USDC decimals on HyperLiquid
export const USDC_DECIMALS = 6;
export const USDC_BASE = 10n ** 6n;

// Default config values
export const DEFAULTS = {
  NETWORK: NETWORK.TESTNET,
  ORDER_SLIPPAGE_PERCENT: 2,
  MIN_ORDER_SIZE_USDC: 1,
};
