import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
// @ts-expect-error The production subagent launcher is an ESM .mjs entrypoint without declarations.
import * as cosSubagent from '../external-subagent-skill/bin/cos-subagent.mjs';
const {
  CHILD_ENV_KEYS,
  childEnvironment,
  ensureOracleHome,
  launchWithFailureFence,
  oracleSessionReceipt,
  profile,
  verifyOracleProvenance,
  waitForSpawnAdmission
} = cosSubagent;

let tempDir = '';

beforeEach(async () => {
  tempDir = await makeTempDir('cos-sec-test-');
});

afterEach(async () => {
  await removeTempDir(tempDir);
});

describe('cos-subagent security controls', () => {
  describe('1. Transport / profile rollback fail-closed', () => {
    it('fails closed on unknown or missing transport', async () => {
      const p1 = path.join(tempDir, 'profile-missing.json');
      await fs.writeFile(p1, JSON.stringify({ failClosed: true }));
      await expect(profile(p1)).rejects.toThrow(/must be explicitly set to oracle-browser or legacy-electron/);

      const p2 = path.join(tempDir, 'profile-invalid.json');
      await fs.writeFile(p2, JSON.stringify({ transport: 'magic-browser', failClosed: true }));
      await expect(profile(p2)).rejects.toThrow(/must be explicitly set to oracle-browser or legacy-electron/);
    });

    it('fails closed when oracle-browser profile is incomplete', async () => {
      const p = path.join(tempDir, 'profile-oracle-incomplete.json');
      await fs.writeFile(p, JSON.stringify({
        transport: 'oracle-browser',
        failClosed: true,
        targetHost: os.hostname(),
        browserUserDataDir: '/chrome/data'
        // missing profileDirectory, oracleExecutable, etc.
      }));
      await expect(profile(p)).rejects.toThrow(/Oracle-derived subagent profile is incomplete/);
    });

    it('fails closed when targetHost mismatches in oracle-browser', async () => {
      const p = path.join(tempDir, 'profile-host-mismatch.json');
      await fs.writeFile(p, JSON.stringify({
        transport: 'oracle-browser',
        failClosed: true,
        targetHost: 'unauthorized-foreign-host',
        browserUserDataDir: '/chrome/data',
        profileDirectory: 'Default',
        oracleExecutable: '/bin/oracle',
        oracleWorkingDir: '/dir',
        oracleSourceCommit: '0'.repeat(40),
        oracleExecutableSha256: '0'.repeat(64),
        oracleHomeDir: '/home',
        oracleAccountId: 'cos-subagent',
        oracleAccountRole: 'subagent',
        defaultConnector: 'Chat On Steroids Core'
      }));
      await expect(profile(p)).rejects.toThrow(/refusing host/);
    });

    it('fails closed when legacy rollback profile is incomplete and refuses fallback to oracle fields', async () => {
      const p = path.join(tempDir, 'profile-legacy-incomplete.json');
      await fs.writeFile(p, JSON.stringify({
        transport: 'legacy-electron',
        failClosed: true,
        appExecutable: '/app/chat',
        // provides Oracle profileDirectory and browserUserDataDir, but NOT legacyBrowserUserDataDir or legacyProfileDirectory
        profileDirectory: 'Default',
        browserUserDataDir: '/chrome/data'
      }));
      await expect(profile(p)).rejects.toThrow(/Chat On Steroids rollback profile is incomplete: legacyBrowserUserDataDir, legacyProfileDirectory/);
    });

    it('succeeds with complete legacy rollback profile without ambient overrides', async () => {
      const p = path.join(tempDir, 'profile-legacy-complete.json');
      await fs.writeFile(p, JSON.stringify({
        transport: 'legacy-electron',
        failClosed: true,
        appExecutable: '/app/chat',
        legacyBrowserUserDataDir: '/chrome/legacy',
        legacyProfileDirectory: 'Profile 173'
      }));
      const loaded = await profile(p);
      expect(loaded.transport).toBe('legacy-electron');
      expect(loaded.legacyProfileDirectory).toBe('Profile 173');
    });

    it('succeeds with current repository profile.json pinned to oracle-browser', async () => {
      const loaded = await profile();
      expect(loaded.transport).toBe('oracle-browser');
      expect(loaded.failClosed).toBe(true);
      expect(loaded.targetHost).toBe('mac-studio-dodo');
      expect(loaded.profileDirectory).toBe('Default');
      expect(loaded.browserUserDataDir).toContain('.chatonsteroids/oracle-subagent/browser-profile');
      expect(loaded.legacyProfileDirectory).toBe('Profile 173');
      expect(loaded.legacyBrowserUserDataDir).toBeDefined();
      expect(loaded.oracleSourceCommit).toBe('ffcac19056b90cf610e4b20ece04aee232f82423');
      expect(loaded.oracleExecutableSha256).toBe('e728723b6b92a7aee58a4376fa30ecb9f8bdd75af3ff353d93b087c7f120d6c3');
    });
  });

  describe('2. Environment child process allowlist', () => {
    it('strips API keys and sensitive environment variables from child env', () => {
      try {
        process.env.OPENAI_API_KEY = 'sk-secret-leak';
        process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
        process.env.COS_SUBAGENT_OVERRIDE = 'evil';
        process.env.ORACLE_BROWSER_INJECT = 'tamper';
        process.env.DISCORD_TOKEN = 'secret-discord';

        const env = childEnvironment({ EXTRA_ALLOWED: 'safe' });

        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.COS_SUBAGENT_OVERRIDE).toBeUndefined();
        expect(env.ORACLE_BROWSER_INJECT).toBeUndefined();
        expect(env.DISCORD_TOKEN).toBeUndefined();
        expect(env.USER).toBeUndefined();
        expect(env.LOGNAME).toBeUndefined();
        expect(env.SHELL).toBeUndefined();
        expect(env.EXTRA_ALLOWED).toBe('safe');

        for (const key of Object.keys(env)) {
          if (key === 'EXTRA_ALLOWED') continue;
          expect(CHILD_ENV_KEYS.has(key) || key.startsWith('LC_')).toBe(true);
        }
      } finally {
        delete process.env.OPENAI_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.COS_SUBAGENT_OVERRIDE;
        delete process.env.ORACLE_BROWSER_INJECT;
        delete process.env.DISCORD_TOKEN;
      }
    });
  });

  describe('3. Dedicated Oracle identity guard', () => {
    it('refuses the real legacy-root/Profile 173 mismatch against the dedicated Default identity', async () => {
      const oracleHomeDir = path.join(tempDir, 'oracle-home-mismatch');
      const browserUserDataDir = path.join(tempDir, 'dedicated-browser-root');
      const legacyBrowserUserDataDir = path.join(tempDir, 'ordinary-chrome-root');
      await fs.mkdir(oracleHomeDir, { recursive: true });
      await fs.writeFile(path.join(oracleHomeDir, 'config.json'), JSON.stringify({
        accountPool: {
          accounts: {
            'cos-subagent': {
              providers: ['chatgpt'],
              profile: 'chat-on-steroids-subagent',
              chromeProfile: 'Profile 173',
              profileDir: legacyBrowserUserDataDir,
              role: 'subagent',
              enabled: true
            }
          }
        }
      }));

      await expect(ensureOracleHome({
        oracleHomeDir,
        browserUserDataDir,
        profileDirectory: 'Default',
        oracleAccountId: 'cos-subagent',
        oracleAccountRole: 'subagent'
      })).rejects.toThrow(/disagrees with the authorized Chat On Steroids profile/);
    });

    it('keeps an existing matching mapping pinned instead of changing its identity', async () => {
      const oracleHomeDir = path.join(tempDir, 'oracle-home-match');
      const browserUserDataDir = path.join(tempDir, 'dedicated-browser-root-match');
      await fs.mkdir(oracleHomeDir, { recursive: true });
      await fs.writeFile(path.join(oracleHomeDir, 'config.json'), JSON.stringify({
        accountPool: {
          accounts: {
            'cos-subagent': {
              providers: ['chatgpt'],
              profile: 'chat-on-steroids-subagent',
              chromeProfile: 'Default',
              profileDir: browserUserDataDir,
              role: 'subagent',
              enabled: true
            }
          }
        }
      }));

      await expect(ensureOracleHome({
        oracleHomeDir,
        browserUserDataDir,
        profileDirectory: 'Default',
        oracleAccountId: 'cos-subagent',
        oracleAccountRole: 'subagent'
      })).resolves.toMatchObject({
        oracleHome: path.resolve(oracleHomeDir),
        profileRoot: path.resolve(browserUserDataDir)
      });
      const written = JSON.parse(await fs.readFile(path.join(oracleHomeDir, 'config.json'), 'utf8'));
      expect(written.accountPool.accounts['cos-subagent'].chromeProfile).toBe('Default');
      expect(written.accountPool.accounts['cos-subagent'].profileDir).toBe(path.resolve(browserUserDataDir));
    });
  });

  describe('4. Immutable Oracle provenance and launch admission', () => {
    it('accepts the pinned Oracle source commit and executable digest', async () => {
      const loaded = await profile();
      await expect(verifyOracleProvenance(loaded)).resolves.toMatchObject({
        sourceCommit: 'ffcac19056b90cf610e4b20ece04aee232f82423',
        executableSha256: 'e728723b6b92a7aee58a4376fa30ecb9f8bdd75af3ff353d93b087c7f120d6c3'
      });
    });

    it('fails closed if the pinned Oracle executable digest is changed', async () => {
      const loaded = await profile();
      await expect(
        verifyOracleProvenance({ ...loaded, oracleExecutableSha256: '0'.repeat(64) })
      ).rejects.toThrow(/Oracle executable digest mismatch/);
    });

    it('does not admit a launch until spawn is observed and rejects spawn errors', async () => {
      const admitted = new EventEmitter();
      const success = waitForSpawnAdmission(admitted);
      admitted.emit('spawn');
      await expect(success).resolves.toBeUndefined();

      const rejected = new EventEmitter();
      const failure = waitForSpawnAdmission(rejected);
      rejected.emit('error', new Error('synthetic spawn failure'));
      await expect(failure).rejects.toThrow(/synthetic spawn failure/);
    });

    it('atomically fences post-job launch failure with done.json status=error', async () => {
      const jobDir = path.join(tempDir, 'launch-failure-job');
      await fs.mkdir(jobDir, { recursive: true });
      await expect(
        launchWithFailureFence(jobDir, { transport: 'oracle-browser' }, async () => {
          throw new Error('synthetic admission failure');
        })
      ).rejects.toThrow(/synthetic admission failure/);
      const done = JSON.parse(await fs.readFile(path.join(jobDir, 'done.json'), 'utf8'));
      expect(done.status).toBe('error');
      expect(done.error).toMatch(/synthetic admission failure/);
    });
  });

  describe('5. Mandatory receipt observed identity check', () => {
    it('throws if Oracle session meta.json is missing or corrupt', async () => {
      const oracleHome = path.join(tempDir, 'oracle-home');
      await expect(
        oracleSessionReceipt(oracleHome, 'session-nonexistent', {
          provider: 'chatgpt',
          adapter: 'chatgpt-browser',
          accountRole: 'subagent',
          chromeProfile: 'Default',
          connectorName: 'Chat On Steroids Core'
        })
      ).rejects.toThrow();
    });

    it('throws if providerReceipt or required observed identity fields are missing', async () => {
      const oracleHome = path.join(tempDir, 'oracle-home');
      const sessionDir = path.join(oracleHome, 'sessions', 'session-incomplete');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify({
        id: 'session-incomplete',
        browser: {
          config: {
            // providerReceipt is missing
            connectorName: 'Chat On Steroids Core'
          }
        }
      }));

      await expect(
        oracleSessionReceipt(oracleHome, 'session-incomplete', {
          provider: 'chatgpt',
          adapter: 'chatgpt-browser',
          accountRole: 'subagent',
          chromeProfile: 'Default',
          connectorName: 'Chat On Steroids Core'
        })
      ).rejects.toThrow(/Oracle session identity receipt is incomplete/);
    });

    it('rejects config-only connector identity and requires runtime DOM evidence', async () => {
      const oracleHome = path.join(tempDir, 'oracle-home');
      const sessionDir = path.join(oracleHome, 'sessions', 'session-config-only');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify({
        id: 'session-config-only',
        browser: {
          config: {
            chromeProfile: 'Default',
            connectorName: 'Chat On Steroids Core',
            providerReceipt: {
              provider: 'chatgpt',
              adapter: 'chatgpt-browser',
              accountRole: 'subagent',
              profileKey: 'sha256-hash-key'
            }
          },
          runtime: {
            conversationId: 'conv-12345',
            frozenConversationId: 'conv-12345',
            frozenConversationTargetId: 'target-12345'
          }
        }
      }));

      await expect(
        oracleSessionReceipt(oracleHome, 'session-config-only', {
          provider: 'chatgpt',
          adapter: 'chatgpt-browser',
          accountRole: 'subagent',
          chromeProfile: 'Default',
          connectorName: 'Chat On Steroids Core'
        })
      ).rejects.toThrow(/Oracle session identity receipt is incomplete/);
    });

    it('throws if runtime-observed connectorName mismatches', async () => {
      const oracleHome = path.join(tempDir, 'oracle-home');
      const sessionDir = path.join(oracleHome, 'sessions', 'session-mismatch');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify({
        id: 'session-mismatch',
        browser: {
          config: {
            chromeProfile: 'Default',
            connectorName: 'Chat On Steroids Core',
            providerReceipt: {
              provider: 'chatgpt',
              adapter: 'chatgpt-browser',
              accountRole: 'subagent',
              profileKey: 'sha256-hash-key'
            }
          },
          runtime: {
            conversationId: 'conv-12345',
            frozenConversationId: 'conv-12345',
            frozenConversationTargetId: 'target-12345',
            connectorSelection: {
              requestedName: 'Chat On Steroids Core',
              observedName: 'Wrong Connector',
              exact: true,
              unique: true,
              sameChipBeforeSend: true,
              trustedChoiceInput: true
            }
          }
        }
      }));

      await expect(
        oracleSessionReceipt(oracleHome, 'session-mismatch', {
          provider: 'chatgpt',
          adapter: 'chatgpt-browser',
          accountRole: 'subagent',
          chromeProfile: 'Default',
          connectorName: 'Chat On Steroids Core'
        })
      ).rejects.toThrow(/connector evidence/);
    });

    it('produces valid attested receipt with separated requested and observed fields on match', async () => {
      const oracleHome = path.join(tempDir, 'oracle-home');
      const sessionDir = path.join(oracleHome, 'sessions', 'session-valid');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify({
        id: 'session-valid',
        browser: {
          config: {
            chromeProfile: 'Default',
            connectorName: 'Chat On Steroids Core',
            providerReceipt: {
              provider: 'chatgpt',
              adapter: 'chatgpt-browser',
              accountRole: 'subagent',
              profileKey: 'sha256-profile-redacted-key'
            }
          },
          runtime: {
            conversationId: 'conv-998877',
            frozenConversationId: 'conv-998877',
            frozenConversationTargetId: 'target-998877',
            connectorSelection: {
              requestedName: 'Chat On Steroids Core',
              observedName: 'Chat On Steroids Core',
              exact: true,
              unique: true,
              sameChipBeforeSend: true,
              trustedChoiceInput: true
            }
          }
        }
      }));

      const receipt = await oracleSessionReceipt(oracleHome, 'session-valid', {
        provider: 'chatgpt',
        adapter: 'chatgpt-browser',
        accountRole: 'subagent',
        chromeProfile: 'Default',
        connectorName: 'Chat On Steroids Core'
      });

      expect(receipt.transport).toBe('oracle-browser');
      expect(receipt.host).toBe(os.hostname());
      expect(receipt.oracleSessionId).toBe('session-valid');
      expect(receipt.requested).toEqual({
        provider: 'chatgpt',
        adapter: 'chatgpt-browser',
        accountRole: 'subagent',
        chromeProfile: 'Default',
        connectorName: 'Chat On Steroids Core'
      });
      expect(receipt.observed).toEqual({
        provider: 'chatgpt',
        adapter: 'chatgpt-browser',
        accountRole: 'subagent',
        profileKey: 'sha256-profile-redacted-key',
        chromeProfile: 'Default',
        connectorName: 'Chat On Steroids Core',
        connectorSelection: {
          requestedName: 'Chat On Steroids Core',
          observedName: 'Chat On Steroids Core',
          exact: true,
          unique: true,
          sameChipBeforeSend: true,
          trustedChoiceInput: true
        },
        conversationId: 'conv-998877',
        chromeTargetId: 'target-998877'
      });
    });
  });

  describe('6. PII and path metadata leaks removal', () => {
    it('verifies config/profile.json has no personal email addresses and no hardcoded user paths', async () => {
      const repoRoot = path.resolve(__dirname, '..');
      const profileContent = await fs.readFile(
        path.join(repoRoot, 'external-subagent-skill', 'config', 'profile.json'),
        'utf8'
      );
      // No email addresses in tracked profile
      expect(profileContent).not.toMatch(/@/);
      // No absolute user home directory path
      expect(profileContent).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//);
    });

    it('verifies references/PROFILE-IDENTITY.md has no personal email addresses', async () => {
      const repoRoot = path.resolve(__dirname, '..');
      const text = await fs.readFile(
        path.join(repoRoot, 'external-subagent-skill', 'references', 'PROFILE-IDENTITY.md'),
        'utf8'
      );
      expect(text).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    });

    it('verifies external-subagent-skill/PLAN.md has no personal email addresses', async () => {
      const repoRoot = path.resolve(__dirname, '..');
      const text = await fs.readFile(
        path.join(repoRoot, 'external-subagent-skill', 'PLAN.md'),
        'utf8'
      );
      expect(text).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    });
  });
});
