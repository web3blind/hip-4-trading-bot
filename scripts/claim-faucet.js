import { getDecryptedPrivateKey } from '../src/modules/auth.js';
import { loadConfig } from '../src/modules/config.js';
import { ethers } from 'ethers';

const config = await loadConfig();
const privateKey = await getDecryptedPrivateKey();
const wallet = new ethers.Wallet(privateKey);
console.log('Wallet address:', wallet.address);

// Check current balance
const balResp = await fetch('https://api.hyperliquid-testnet.xyz/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'spotClearinghouseState', user: wallet.address }),
});
const balData = await balResp.json();
console.log('Current spot state:', JSON.stringify(balData, null, 2));

// Also check perp balance
const perpResp = await fetch('https://api.hyperliquid-testnet.xyz/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'clearinghouseState', user: wallet.address }),
});
const perpData = await perpResp.json();
console.log('Perp balance:', JSON.stringify(perpData?.marginSummary || {}, null, 2));

// Try faucet drip endpoint
console.log('\n=== Trying faucet ===');

// Try 1: POST /drip
try {
  const r1 = await fetch('https://api.hyperliquid-testnet.xyz/drip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'UsdcDrip', user: wallet.address }),
  });
  console.log('POST /drip status:', r1.status);
  console.log('POST /drip body:', await r1.text());
} catch (e) {
  console.log('POST /drip error:', e.message);
}

// Try 2: GET /drip?user=...
try {
  const r2 = await fetch(`https://api.hyperliquid-testnet.xyz/drip?user=${wallet.address}`);
  console.log('GET /drip status:', r2.status);
  console.log('GET /drip body:', await r2.text());
} catch (e) {
  console.log('GET /drip error:', e.message);
}

// Try 3: POST /exchange with special action
try {
  const timestamp = Date.now();
  const nonce = timestamp;
  
  // Sign a typed data for the testnet drip action
  // The phantom agent approach from the HL API
  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  
  const types = {
    'HyperliquidTransaction:UsdcDrip': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' },
    ],
  };
  
  const value = {
    hyperliquidChain: 'Testnet',
    destination: wallet.address,
    amount: '1000',
  };
  
  const signature = await wallet._signTypedData(domain, types, value);
  
  const r3 = await fetch('https://api.hyperliquid-testnet.xyz/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: { type: 'usdcDrip' },
      nonce,
      signature,
    }),
  });
  console.log('POST /exchange usdcDrip status:', r3.status);
  console.log('POST /exchange usdcDrip body:', await r3.text());
} catch (e) {
  console.log('POST /exchange error:', e.message);
}
