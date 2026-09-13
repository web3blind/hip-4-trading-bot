import { readFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { DATA_DIR, loadConfig, saveConfig } from './config.js';
import { importWallet, validateWalletConfig, verifyAgentAuthorization, getMachineKey, encrypt, decrypt } from './auth.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function diskConfig() {
  try { return await readFile(join(DATA_DIR, 'config.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
let saves = Promise.resolve();
/** Persist only an authorized API signer. Caller deletes incoming Telegram text first.
 * persist permits the shared runtime activation queue to commit the config while
 * client/workers are stopped. It must call saveConfig with the provided config.
 */
export function saveApiWalletConnection({ accountAddress, privateKey, network, expectedConfig, fetchImpl = fetch, persist = saveConfig }) {
  const task = saves.then(async () => {
    if (typeof privateKey !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKey) || !ethers.utils.isAddress(accountAddress) || accountAddress.toLowerCase() === ethers.constants.AddressZero || !['mainnet','testnet'].includes(network)) throw new Error('Invalid API wallet credentials');
    let signer;
    try { signer = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`); }
    catch { throw new Error('Invalid API wallet credentials'); }
    const owner = ethers.utils.getAddress(accountAddress);
    if (owner === signer.address) throw new Error('Use an API wallet key, not the main wallet key');
    const previous = await loadConfig();
    if (!expectedConfig || !same(previous, expectedConfig)) throw new Error('Configuration changed; open connection again');
    const baseline = await diskConfig();
    // A temporary connector overlays disk config: never claim it is durable.
    if (baseline !== null && !same(JSON.parse(baseline), previous)) throw new Error('Temporary session active; persistent setup unavailable');
    const validUntil = await verifyAgentAuthorization({ walletAddress: owner, agentAddress: signer.address, hlNetwork: network }, { fetchImpl });
    const imported = await importWallet(signer.privateKey);
    const next = { ...previous, authMode: 'agent', walletAddress: owner, agentAddress: signer.address, hlNetwork: network, agentValidUntil: validUntil,
      encrypted: { ...previous.encrypted, privateKey: imported.encryptedPrivateKey },
      outcomeBuilderEnabled: previous.walletAddress?.toLowerCase() === owner.toLowerCase() && previous.hlNetwork === network ? !!previous.outcomeBuilderEnabled : false };
    await validateWalletConfig(next);
    if (baseline !== null && (previous.walletAddress || previous.encrypted?.privateKey)) {
      const machineKey = await getMachineKey();
      const encrypted = await encrypt(baseline, machineKey);
      const backup = join(DATA_DIR, `config.backup-${Date.now()}-${randomBytes(6).toString('hex')}.enc`);
      const file = await open(backup, 'wx', 0o600);
      try { await file.writeFile(encrypted, 'utf8'); await file.sync(); } finally { await file.close(); }
      if (await decrypt(await readFile(backup, 'utf8'), machineKey) !== baseline) throw new Error('Encrypted backup verification failed');
    }
    if (await diskConfig() !== baseline || !same(await loadConfig(), previous)) throw new Error('Configuration changed; open connection again');
    try {
      await persist(next);
      const stored = await diskConfig();
      if (stored === null || !same(JSON.parse(stored), next) || await validateWalletConfig(JSON.parse(stored)) !== signer.privateKey) throw new Error('Saved credential verification failed');
    } catch (error) {
      // Roll back only our own write, never another actor's changed configuration.
      const current = await diskConfig();
      if (current !== null && same(JSON.parse(current), next)) {
        if (baseline === null) await unlink(join(DATA_DIR, 'config.json'));
        else await saveConfig(JSON.parse(baseline));
      }
      throw new Error('Connection was not activated; previous configuration retained');
    }
    return next;
  });
  saves = task.catch(() => {});
  return task;
}
