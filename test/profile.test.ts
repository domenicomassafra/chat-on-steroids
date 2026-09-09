import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { applyProfilePaths, bridgePorts, browserProfileDir, extensionBridgePorts, profileLabel, resolveProfilePaths } from '../src/main/profile.js';

describe('owner production profiles', () => {
  it('preserves the upstream default when COS_HOME is absent', () => {
    expect(resolveProfilePaths({}, '/Users/example')).toBeNull();
  });

  it('resolves one explicit data root and a nested Electron session root', () => {
    expect(resolveProfilePaths({ COS_HOME: '~/AI-Runtimes/cos/account-b' }, '/Users/example')).toEqual({
      userData: path.join('/Users/example', 'AI-Runtimes/cos/account-b'),
      sessionData: path.join('/Users/example', 'AI-Runtimes/cos/account-b/electron-session')
    });
  });

  it('resolves an explicit Chromium identity root without coupling it to Electron state', () => {
    expect(browserProfileDir({ COS_BROWSER_USER_DATA_DIR: '~/AI-Runtimes/cos/a/browser' }, '/Users/example'))
      .toBe('/Users/example/AI-Runtimes/cos/a/browser');
    expect(browserProfileDir({}, '/Users/example')).toBeNull();
  });

  it('sets both Electron paths before the caller takes its singleton lock', () => {
    const setPath = vi.fn();
    const parent = mkdtempSync(path.join(tmpdir(), 'cos-profile-test-'));
    const base = path.join(parent, 'account-b');
    try {
      const result = applyProfilePaths({ setPath }, { COS_HOME: base }, '/unused');
      expect(result?.userData).toBe(base);
      expect(setPath).toHaveBeenNthCalledWith(1, 'userData', base);
      expect(setPath).toHaveBeenNthCalledWith(2, 'sessionData', path.join(base, 'electron-session'));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('supports explicit per-profile bridge ranges without removing the upstream test hook', () => {
    expect(bridgePorts({})).toEqual([8765, 8766, 8767, 8768, 8769]);
    expect(bridgePorts({ CLF_BRIDGE_PORTS: '0' })).toEqual([0]);
    expect(bridgePorts({ COS_BRIDGE_PORTS: '8775,8776,8776', CLF_BRIDGE_PORTS: '0' })).toEqual([8775, 8776]);
    expect(extensionBridgePorts({ CLF_BRIDGE_PORTS: '0' })).toEqual([8765, 8766, 8767, 8768, 8769]);
    expect(extensionBridgePorts({ COS_BRIDGE_PORTS: '8775,8776', CLF_BRIDGE_PORTS: '0' })).toEqual([8775, 8776]);
  });

  it('keeps the optional visible profile label bounded and display-safe', () => {
    expect(profileLabel({ COS_PROFILE: 'Account B / Personal' })).toBe('Account B - Personal');
    expect(profileLabel({})).toBeNull();
  });
});
