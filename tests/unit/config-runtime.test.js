import test from 'node:test';
import assert from 'node:assert/strict';

import { getHlNetwork, getTranslationRuntimeConfig } from '../../src/modules/config.js';

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('getHlNetwork returns testnet by default', () => {
  withEnv({ HL_NETWORK: null }, () => {
    assert.equal(getHlNetwork(), 'testnet');
  });
});

test('getHlNetwork returns env value when set', () => {
  withEnv({ HL_NETWORK: 'mainnet' }, () => {
    assert.equal(getHlNetwork(), 'mainnet');
  });
});

test('getTranslationRuntimeConfig returns not-ready config when required fields are missing', () => {
  withEnv(
    {
      TRANSLATION_ENABLED: 'true',
      TRANSLATION_SERVICE: 'openrouter',
      OPENROUTER_API_KEY: null,
      OPENROUTER_MODEL: null,
      OPENROUTER_BASE_URL: null
    },
    () => {
      const cfg = getTranslationRuntimeConfig();
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.service, 'openrouter');
      assert.equal(cfg.ready, false);
      assert.ok(cfg.missing.includes('OPENROUTER_API_KEY'));
      assert.ok(cfg.missing.includes('OPENROUTER_MODEL'));
      assert.ok(cfg.missing.includes('OPENROUTER_BASE_URL'));
    }
  );
});

test('getTranslationRuntimeConfig returns ready config when all required fields exist', () => {
  withEnv(
    {
      TRANSLATION_ENABLED: 'true',
      TRANSLATION_SERVICE: 'openrouter',
      OPENROUTER_API_KEY: 'token',
      OPENROUTER_MODEL: 'model-a',
      OPENROUTER_FALLBACK_MODELS: 'model-b,model-c',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1'
    },
    () => {
      const cfg = getTranslationRuntimeConfig();
      assert.equal(cfg.ready, true);
      assert.deepEqual(cfg.models, ['model-a', 'model-b', 'model-c']);
    }
  );
});
