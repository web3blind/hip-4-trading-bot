import { readFile, writeFile, mkdir, access, open, rename, unlink } from 'fs/promises';
import { dirname, join, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createContext, safeLogInfo } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Config file path
export const DATA_DIR = process.env.HIP4_DATA_DIR || join(__dirname, '..', '..', 'data');
if (!isAbsolute(DATA_DIR)) throw new Error('HIP4_DATA_DIR must be absolute');
if (process.env.HIP4_DATA_DIR && resolve(DATA_DIR) === resolve(__dirname, '..', '..', 'data')) throw new Error('HIP4_DATA_DIR must not target live data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const CONFIG_DIR = dirname(CONFIG_PATH);
let saveConfigQueue = Promise.resolve();
let sessionConfig = null;
export function setSessionConfig(config) { sessionConfig = config ? structuredClone(config) : null; }

// Default config structure for first run - all fields empty
const DEFAULT_CONFIG = {
  encrypted: {
    privateKey: ''
  },
  walletAddress: '',
  authMode: 'wallet',
  agentAddress: '',
  outcomeBuilderEnabled: false,
  hlNetwork: process.env.HL_NETWORK || 'testnet',
  language: '',
  notifications: {
    priceChangePercent: 10,
    priceRepeatStepPercent: 2,
    alertCooldownSeconds: 300
  }
};

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await access(CONFIG_DIR);
  } catch {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

// Check if config file exists
async function configFileExists() {
  try {
    await access(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

// Ensure config file exists - creates it with empty fields if missing
export async function ensureConfigFileExists() {
  if (sessionConfig) return structuredClone(sessionConfig);
  await ensureDataDir();
  
  const exists = await configFileExists();
  if (!exists) {
    // Create config file with default skeleton (empty fields)
    const config = structuredClone(DEFAULT_CONFIG);
    await saveConfig(config);
    const ctx = createContext('config', 'ensureConfigFileExists');
    safeLogInfo(ctx, 'Config file created with default skeleton');
    return config;
  }
  
  // File exists, load and return it
  return await loadConfig();
}

// Load configuration from file
export async function loadConfig() {
  if (sessionConfig) return structuredClone(sessionConfig);
  try {
    await ensureDataDir();
    const data = await readFile(CONFIG_PATH, 'utf8');
    const config = JSON.parse(data);
    
    // Return config even if wallet is not configured
    // Language selection should work before wallet initialization
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Config file doesn't exist, return default
      const ctx = createContext('config', 'loadConfig');
      safeLogInfo(ctx, 'Config file not found, using defaults');
      return structuredClone(DEFAULT_CONFIG);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Config file is corrupted JSON: ${error.message}`);
    }
    throw error;
  }
}

async function fsyncFile(path) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } catch (error) {
    if (!isIgnorableFsyncError(error)) {
      throw error;
    }
  } finally {
    await file.close();
  }
}

function isIgnorableFsyncError(error) {
  const code = String(error?.code || '').toUpperCase();
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP';
}

async function fsyncDirectory(path) {
  // Directory fsync is not available on every platform (notably some Windows setups).
  // Best-effort only.
  let dirHandle = null;
  try {
    dirHandle = await open(path, 'r');
    await dirHandle.sync();
  } catch (error) {
    if (!isIgnorableFsyncError(error)) {
      throw error;
    }
  }
  finally {
    if (dirHandle) {
      try { await dirHandle.close(); } catch {}
    }
  }
}

function withSaveConfigLock(task) {
  const run = saveConfigQueue.then(task, task);
  saveConfigQueue = run.catch(() => {});
  return run;
}

// All config mutations share this queue across settings, wallet setup and MCP keys.
// The lock covers the read as well as the write; locking just rename is not sufficient.
export async function mutateConfig(mutator) {
  if (typeof mutator !== 'function') throw new Error('Config mutator required');
  return withSaveConfigLock(async () => {
    const config = await loadConfig();
    const result = await mutator(config);
    await writeConfigUnlocked(config);
    return result;
  });
}

async function writeConfigUnlocked(config) {
  if (sessionConfig) { sessionConfig = structuredClone(config); return; }
  await ensureDataDir();

  const serialized = JSON.stringify(config, null, 2);
  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fsyncFile(tempPath);
    await rename(tempPath, CONFIG_PATH);
    await fsyncDirectory(CONFIG_DIR);
  } catch (error) {
    try { await unlink(tempPath); } catch {}
    throw error;
  }
  const ctx = createContext('config', 'saveConfig');
  safeLogInfo(ctx, 'Config saved successfully');
}

// Save the full configuration. Wallet-replacement callers must supply the snapshot
// they reviewed; a concurrent MCP key/settings update then fails instead of vanishing.
export async function saveConfig(config, { expectedConfig } = {}) {
  return withSaveConfigLock(async () => {
    if (expectedConfig !== undefined && JSON.stringify(await loadConfig()) !== JSON.stringify(expectedConfig)) {
      throw new Error('Configuration changed; open the review again');
    }
    await writeConfigUnlocked(config);
  });
}

// Update specific config field
export async function updateConfig(field, value) {
  return mutateConfig(config => {
    const keys = field.split('.');
    let target = config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]]) target[keys[i]] = {};
      target = target[keys[i]];
    }
    target[keys[keys.length - 1]] = value;
    return config;
  });
}

// Get notification settings with defaults
export async function getNotificationSettings() {
  const config = await loadConfig();
  const defaults = DEFAULT_CONFIG.notifications;
  const notif = config.notifications || {};
  return {
    priceChangePercent: notif.priceChangePercent ?? defaults.priceChangePercent,
    priceRepeatStepPercent: notif.priceRepeatStepPercent ?? defaults.priceRepeatStepPercent,
    alertCooldownSeconds: notif.alertCooldownSeconds ?? defaults.alertCooldownSeconds,
  };
}

// Update a single notification setting
export async function setNotificationSetting(key, value) {
  return mutateConfig(config => {
    if (!config.notifications) config.notifications = {};
    config.notifications[key] = value;
    return config;
  });
}

// Check if language is configured
export async function isLanguageConfigured() {
  try {
    const config = await loadConfig();
    return config.language && config.language !== '';
  } catch {
    return false;
  }
}

// Check if wallet is configured
export async function isWalletConfigured() {
  try {
    const config = await loadConfig();
    const addressValid = /^0x[a-fA-F0-9]{40}$/.test(config.walletAddress || '');
    // Only an explicitly installed in-memory agent session may omit its key.
    // Persisted agent configs must still contain the encrypted signer.
    const sessionAgent = sessionConfig && config.authMode === 'agent' &&
      /^0x[a-fA-F0-9]{40}$/.test(config.agentAddress || '');
    return Boolean(addressValid && (sessionAgent || config.encrypted?.privateKey));
  } catch {
    return false;
  }
}

// Check if this is first run (no wallet configured) - legacy function
export async function isFirstRun() {
  return !(await isWalletConfigured());
}

export function getHlNetwork() {
  return toNonEmptyEnv(process.env.HL_NETWORK) || 'testnet';
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function toNonEmptyEnv(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : '';
}

function splitCsvEnv(value) {
  const raw = toNonEmptyEnv(value);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Runtime translation settings are sourced from environment variables only.
export function getTranslationRuntimeConfig() {
  const enabled = parseBooleanEnv(process.env.TRANSLATION_ENABLED, false);
  const service = toNonEmptyEnv(process.env.TRANSLATION_SERVICE || 'openrouter').toLowerCase();
  const apiKey = toNonEmptyEnv(process.env.OPENROUTER_API_KEY);
  const model = toNonEmptyEnv(process.env.OPENROUTER_MODEL);
  const url = toNonEmptyEnv(process.env.OPENROUTER_BASE_URL);
  const fallbackModels = splitCsvEnv(process.env.OPENROUTER_FALLBACK_MODELS);
  const models = Array.from(new Set([model, ...fallbackModels].filter(Boolean)));

  const missing = [];
  if (!apiKey) missing.push('OPENROUTER_API_KEY');
  if (models.length === 0) missing.push('OPENROUTER_MODEL');
  if (!url) missing.push('OPENROUTER_BASE_URL');

  const ready = enabled && service === 'openrouter' && missing.length === 0;

  return {
    enabled,
    service,
    apiKey,
    model,
    models,
    fallbackModels,
    url,
    missing,
    ready
  };
}
