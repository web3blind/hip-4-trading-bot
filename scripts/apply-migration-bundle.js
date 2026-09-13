import { createDecipheriv, privateDecrypt, constants } from 'crypto';
import { dirname, join } from 'path';
import { readFile, unlink } from 'fs/promises';
import { Wallet } from 'ethers';

import { encrypt, decrypt, getMachineKey } from '../src/modules/auth.js';
import { saveConfig, DATA_DIR } from '../src/modules/config.js';
import {
  decodeBase64,
  formatFingerprint,
  getPublicKeyFingerprint,
  parseArgs,
  readJson,
  resolvePathFromCwd,
  normalizeFingerprint
} from './migration-common.js';

function ensureBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid migration bundle payload');
  }
  if (bundle.version !== 'migration-bundle-v1') {
    throw new Error(`Unsupported bundle version: ${bundle.version || 'unknown'}`);
  }
  if (!bundle.requestId || !bundle.encryptedKey || !bundle.iv || !bundle.authTag || !bundle.ciphertext) {
    throw new Error('Migration bundle is missing required fields');
  }
}

function ensureRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('Invalid migration request payload');
  }
  if (request.version !== 'migration-request-v1') {
    throw new Error(`Unsupported request version: ${request.version || 'unknown'}`);
  }
  if (!request.requestId || !request.publicKeyPem || !request.publicKeyFingerprint) {
    throw new Error('Migration request is missing required fields');
  }
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.request || !args.bundle) {
    throw new Error('Usage: node scripts/apply-migration-bundle.js --request <request.json> --bundle <bundle.json>');
  }

  const requestPath = resolvePathFromCwd(args.request);
  const bundlePath = resolvePathFromCwd(args.bundle);
  const request = await readJson(requestPath);
  const bundle = await readJson(bundlePath);
  ensureRequest(request);
  ensureBundle(bundle);

  if (bundle.requestId !== request.requestId) {
    throw new Error(`Request ID mismatch: bundle=${bundle.requestId} request=${request.requestId}`);
  }

  const requestFingerprint = getPublicKeyFingerprint(request.publicKeyPem);
  if (normalizeFingerprint(requestFingerprint) !== normalizeFingerprint(request.publicKeyFingerprint)) {
    throw new Error('Request fingerprint does not match request public key');
  }
  if (normalizeFingerprint(bundle.publicKeyFingerprint) !== normalizeFingerprint(requestFingerprint)) {
    throw new Error('Bundle fingerprint does not match request fingerprint');
  }

  const expiresAtMs = Date.parse(String(request.expiresAt || ''));
  if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs && !args['allow-expired']) {
    throw new Error('Migration request is expired. Re-run with --allow-expired only if you trust this bundle.');
  }

  const privateKeyPath = args['private-key']
    ? resolvePathFromCwd(args['private-key'])
    : join(dirname(requestPath), String(request.privateKeyFile || '').trim());
  if (!privateKeyPath || privateKeyPath === dirname(requestPath)) {
    throw new Error('Cannot determine migration private key path. Pass --private-key explicitly.');
  }

  const privateKeyPem = await readFile(privateKeyPath, 'utf8');
  const encryptedKey = decodeBase64(bundle.encryptedKey, 'encryptedKey');
  const aesKey = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    encryptedKey
  );
  if (aesKey.length !== 32) {
    throw new Error('Decrypted bundle AES key length is invalid');
  }

  const iv = decodeBase64(bundle.iv, 'iv');
  const authTag = decodeBase64(bundle.authTag, 'authTag');
  const ciphertext = decodeBase64(bundle.ciphertext, 'ciphertext');
  if (iv.length !== 12) throw new Error('Bundle iv must be 12 bytes');
  if (authTag.length !== 16) throw new Error('Bundle authTag must be 16 bytes');

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8'));

  if (payload.version !== 'migration-payload-v1') {
    throw new Error(`Unsupported payload version: ${payload.version || 'unknown'}`);
  }
  if (payload.requestId !== request.requestId) {
    throw new Error(`Payload requestId mismatch: ${payload.requestId} !== ${request.requestId}`);
  }

  const privateKey = String(payload.privateKey || '').trim();
  if (!privateKey) throw new Error('Payload signer key missing');

  const derivedWalletAddress = new Wallet(privateKey).address;
  const payloadWalletAddress = String(payload.walletAddress || '').trim();
  const authMode = payload.config?.authMode || 'wallet';
  if (!['wallet', 'agent'].includes(authMode)) throw new Error('Invalid auth mode');
  if (!/^0x[0-9a-f]{40}$/i.test(payloadWalletAddress)) throw new Error('Invalid owner address');
  if (authMode === 'agent' && String(payload.config?.agentAddress).toLowerCase() !== derivedWalletAddress.toLowerCase()) throw new Error('Agent signer mismatch');
  if (authMode === 'wallet' && payloadWalletAddress.toLowerCase() !== derivedWalletAddress.toLowerCase()) {
    throw new Error('Payload walletAddress does not match payload privateKey');
  }

  const machineKey = await getMachineKey();
  const encryptedPrivateKey = await encrypt(privateKey, machineKey);
  const baseConfig = toObject(payload.config);
  const mergedStrategies = toObject(baseConfig.strategies);
  const mergedNotifications = toObject(baseConfig.notifications);

  const nextConfig = {
    ...baseConfig,
    authMode,
    hlNetwork: baseConfig.hlNetwork || 'testnet',
    walletAddress: payloadWalletAddress || derivedWalletAddress,
    language: String(baseConfig.language || 'ru'),
    strategies: {
      stopLoss: Number(baseConfig?.strategies?.stopLoss ?? -10),
      takeProfit: Number(baseConfig?.strategies?.takeProfit ?? 30),
      maxAskPrice: Number(baseConfig?.strategies?.maxAskPrice ?? 0.49),
      ...mergedStrategies
    },
    notifications: {
      priceChangePercent: Number(baseConfig?.notifications?.priceChangePercent ?? 10),
      priceRepeatStepPercent: Number(baseConfig?.notifications?.priceRepeatStepPercent ?? 2),
      alertCooldownSeconds: Number(baseConfig?.notifications?.alertCooldownSeconds ?? 300),
      ...mergedNotifications
    },
    encrypted: {
      privateKey: encryptedPrivateKey
    }
  };

  await saveConfig(nextConfig);

  // Read the committed disk file, not the in-memory object or session overlay.
  const saved = await readJson(join(DATA_DIR, 'config.json'));
  for (const field of ['walletAddress', 'authMode', 'agentAddress', 'hlNetwork', 'outcomeBuilderEnabled']) {
    if (saved[field] !== nextConfig[field]) throw new Error(`Post-save verification failed: ${field}`);
  }
  const verifyPrivateKey = await decrypt(saved.encrypted.privateKey, machineKey);
  if (verifyPrivateKey !== privateKey) {
    throw new Error('Post-save verification failed: private key cannot be decrypted back');
  }

  if (!args['keep-private-key']) {
    await unlink(privateKeyPath);
    try {
      await readFile(privateKeyPath);
      throw new Error('One-time key still exists after deletion');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  if (args['delete-request']) {
    try {
      await unlink(requestPath);
    } catch {}
  }

  console.log('Migration bundle applied successfully.');
  console.log(`Wallet: ${nextConfig.walletAddress}`);
  console.log(`Fingerprint: ${formatFingerprint(requestFingerprint)}`);
  if (!args['keep-private-key']) {
    console.log('One-time migration private key file was removed.');
  }
}

main().catch((error) => {
  console.error(`apply-migration-bundle failed: ${error?.message || error}`);
  process.exit(1);
});
