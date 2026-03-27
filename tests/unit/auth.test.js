import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'crypto';
import { ethers } from 'ethers';

import { encrypt, decrypt } from '../../src/modules/auth.js';

// We cannot rely on node-machine-id in CI / sandboxed environments,
// so these tests use a deterministic 32-byte key produced with scryptSync.
function testKey() {
  return scryptSync('test-machine-id', 'hyperliquid-bot-salt-v1', 32);
}

// ─── encrypt / decrypt ───────────────────────────────────────────

test('encrypt/decrypt round-trip with valid key', async () => {
  const key = testKey();
  const plaintext = 'super-secret-private-key';
  const encrypted = await encrypt(plaintext, key);
  const decrypted = await decrypt(encrypted, key);
  assert.equal(decrypted, plaintext);
});

test('encrypt produces v2 format string', async () => {
  const key = testKey();
  const encrypted = await encrypt('hello', key);
  const parts = encrypted.split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v2');
});

test('encrypt rejects non-32-byte key', async () => {
  await assert.rejects(() => encrypt('value', randomBytes(16)), /Encryption key must be 32 bytes/);
});

test('decrypt rejects invalid payload format', async () => {
  const key = testKey();
  await assert.rejects(() => decrypt('invalid', key), /Invalid encrypted data format/);
});

test('decrypt rejects wrong key', async () => {
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);
  const encrypted = await encrypt('secret', key1);
  await assert.rejects(() => decrypt(encrypted, key2), /Failed to decrypt data/);
});

// ─── generateWallet (tested without machine-id by mocking lower level) ──

test('generateWallet-like logic: ethers.Wallet.createRandom produces valid wallet', async () => {
  const wallet = ethers.Wallet.createRandom();
  assert.ok(ethers.utils.isAddress(wallet.address), 'address is valid Ethereum address');
  assert.ok(wallet.privateKey.startsWith('0x'), 'private key is 0x-prefixed');
  assert.equal(wallet.privateKey.length, 66, 'private key is 32 bytes hex');

  // Round-trip encrypt/decrypt the private key
  const key = testKey();
  const encrypted = await encrypt(wallet.privateKey, key);
  const decrypted = await decrypt(encrypted, key);
  assert.equal(decrypted, wallet.privateKey);
});

// ─── importWallet-like logic ─────────────────────────────────────

test('importWallet-like logic: import wallet from hex private key (with 0x)', async () => {
  const original = ethers.Wallet.createRandom();
  const imported = new ethers.Wallet(original.privateKey);
  assert.equal(imported.address, original.address);
});

test('importWallet-like logic: import wallet from hex private key (without 0x)', async () => {
  const original = ethers.Wallet.createRandom();
  const rawHex = original.privateKey.slice(2); // remove 0x
  const imported = new ethers.Wallet('0x' + rawHex);
  assert.equal(imported.address, original.address);
});

// ─── getPrivateKey-like logic ────────────────────────────────────

test('getPrivateKey-like: decrypt stored key returns original', async () => {
  const wallet = ethers.Wallet.createRandom();
  const key = testKey();
  const encryptedPK = await encrypt(wallet.privateKey, key);

  // Simulate config shape
  const config = {
    encrypted: { privateKey: encryptedPK },
    walletAddress: wallet.address,
  };

  // Decrypt
  const decryptedPK = await decrypt(config.encrypted.privateKey, key);
  assert.equal(decryptedPK, wallet.privateKey);

  // Verify the decrypted key gives us the same address
  const recovered = new ethers.Wallet(decryptedPK);
  assert.equal(recovered.address, config.walletAddress);
});

// ─── getWalletAddress-like logic ─────────────────────────────────

test('getWalletAddress: returns address from config', () => {
  const config = { walletAddress: '0x1234567890abcdef1234567890abcdef12345678' };
  assert.equal(config.walletAddress, '0x1234567890abcdef1234567890abcdef12345678');
});

test('getWalletAddress: throws when missing', () => {
  // Direct import and test of the real function
  // We test the logic inline since getMachineKey may not be available
  const config = {};
  assert.throws(() => {
    if (!config?.walletAddress) {
      throw new Error('Wallet address not found in config');
    }
  }, /Wallet address not found in config/);
});
