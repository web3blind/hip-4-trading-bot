import { ethers } from 'ethers';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { createContext, safeLogInfo, safeLogWarn } from './logger.js';
import { saveConfig } from './config.js';

// Lazy import for node-machine-id (CommonJS compatibility)
async function getMachineIdModule() {
  const module = await import('node-machine-id');
  return module.default || module;
}

const ENCRYPTION_VERSION = 'v2';
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

// ─── Key derivation ──────────────────────────────────────────────

/**
 * Get machine-specific encryption key via node-machine-id + scryptSync.
 */
export async function getMachineKey() {
  try {
    const mod = await getMachineIdModule();
    const id = await mod.machineId();
    return scryptSync(id, 'hyperliquid-bot-salt-v1', AES_KEY_BYTES);
  } catch (error) {
    const ctx = createContext('auth', 'getMachineKey');
    safeLogWarn(ctx, 'Machine ID unavailable, refusing to start', { message: error?.message });
    const e = new Error('Machine ID is not available. Startup aborted for security reasons.');
    e.code = 'MACHINE_ID_UNAVAILABLE';
    throw e;
  }
}

// ─── AES-256-GCM encrypt / decrypt ──────────────────────────────

function assertAes256Key(key) {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new Error(`Encryption key must be ${AES_KEY_BYTES} bytes`);
  }
}

function decodeBase64Strict(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid encrypted data format: ${fieldName} is empty`);
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid encrypted data format: ${fieldName} is not valid base64`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) {
    throw new Error(`Invalid encrypted data format: ${fieldName} base64 is corrupted`);
  }
  return buffer;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns "v2:<iv>:<ciphertext>:<authTag>" (all base64).
 */
export async function encrypt(data, key) {
  assertAes256Key(key);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  return `${ENCRYPTION_VERSION}:${iv.toString('base64')}:${encrypted}:${authTag}`;
}

/**
 * Decrypt AES-256-GCM payload produced by encrypt().
 */
export async function decrypt(encryptedData, key) {
  assertAes256Key(key);

  if (typeof encryptedData !== 'string') {
    throw new Error('Invalid encrypted data format: expected string');
  }

  const parts = encryptedData.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted data format: expected v2:iv:ciphertext:tag');
  }

  const [version, ivBase64, ciphertextBase64, authTagBase64] = parts;
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encrypted data version: ${version || 'unknown'}`);
  }

  const iv = decodeBase64Strict(ivBase64, 'iv');
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`Invalid encrypted data format: iv must be ${GCM_IV_BYTES} bytes`);
  }

  const authTag = decodeBase64Strict(authTagBase64, 'authTag');
  if (authTag.length !== GCM_TAG_BYTES) {
    throw new Error(`Invalid encrypted data format: authTag must be ${GCM_TAG_BYTES} bytes`);
  }

  if (typeof ciphertextBase64 !== 'string' || ciphertextBase64.length === 0) {
    throw new Error('Invalid encrypted data format: ciphertext is empty');
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(ciphertextBase64) || ciphertextBase64.length % 4 !== 0) {
    throw new Error('Invalid encrypted data format: ciphertext is not valid base64');
  }
  const ciphertextBuffer = Buffer.from(ciphertextBase64, 'base64');
  if (ciphertextBuffer.toString('base64') !== ciphertextBase64) {
    throw new Error('Invalid encrypted data format: ciphertext base64 is corrupted');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Failed to decrypt data: ${error?.message || error}`);
  }
}

// ─── Wallet management ───────────────────────────────────────────

/**
 * Generate a new random Ethereum wallet, encrypt the private key,
 * and save the config. Returns { walletAddress, encryptedPrivateKey }.
 */
export async function generateWallet() {
  const ctx = createContext('auth', 'generateWallet');
  safeLogInfo(ctx, 'Generating new wallet');

  const wallet = ethers.Wallet.createRandom();
  const machineKey = await getMachineKey();
  const encryptedPrivateKey = await encrypt(wallet.privateKey, machineKey);

  return {
    walletAddress: wallet.address,
    encryptedPrivateKey,
  };
}

/**
 * Import an existing wallet from a hex private key.
 * @param {string} privateKeyHex - Private key with or without 0x prefix
 * @returns {{ walletAddress: string, encryptedPrivateKey: string }}
 */
export async function importWallet(privateKeyHex) {
  const ctx = createContext('auth', 'importWallet');
  safeLogInfo(ctx, 'Importing wallet from private key');

  const key = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  const wallet = new ethers.Wallet(key);

  const machineKey = await getMachineKey();
  const encryptedPrivateKey = await encrypt(wallet.privateKey, machineKey);

  return {
    walletAddress: wallet.address,
    encryptedPrivateKey,
  };
}

/**
 * Decrypt and return the private key from a config object.
 * @param {object} config - Config with config.encrypted.privateKey
 * @returns {Promise<string>} Hex private key (0x-prefixed)
 */
export async function getPrivateKey(config) {
  if (!config?.encrypted?.privateKey) {
    throw new Error('Private key not found in config');
  }
  const machineKey = await getMachineKey();
  return await decrypt(config.encrypted.privateKey, machineKey);
}

/**
 * Return the wallet address from a config object.
 * @param {object} config
 * @returns {string}
 */
export function getWalletAddress(config) {
  if (!config?.walletAddress) {
    throw new Error('Wallet address not found in config');
  }
  return config.walletAddress;
}

/**
 * Backward-compatible alias: decrypt private key from the stored config file.
 * Used by workers.js, security.js, bot.js etc.
 */
export async function getDecryptedPrivateKey() {
  const { loadConfig } = await import('./config.js');
  const config = await loadConfig();
  return getPrivateKey(config);
}

/**
 * Initialize a new wallet and save to config (convenience wrapper).
 * Called on first run.
 */
export async function initializeWallet() {
  const ctx = createContext('auth', 'initializeWallet');
  safeLogInfo(ctx, 'Initializing new wallet');

  const { walletAddress, encryptedPrivateKey } = await generateWallet();

  const config = {
    encrypted: {
      privateKey: encryptedPrivateKey,
    },
    walletAddress,
    language: '',
    notifications: {
      priceChangePercent: 10,
      priceRepeatStepPercent: 2,
      alertCooldownSeconds: 300,
    },
  };

  await saveConfig(config);

  return {
    address: walletAddress,
    warning: `⚠️ WARNING!\nNew wallet created for HyperLiquid.\nAddress: ${walletAddress}\n\nThis is a NEW wallet. Fund it separately.\nDO NOT use your main wallet!\n\nExport and save the private key (Settings → Export Key).\nAccess may be lost if the OS is reinstalled or moved to a new device.`,
  };
}
