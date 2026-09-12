import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769] as const;

export interface ElectronProfilePaths {
  userData: string;
  sessionData: string;
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.resolve(homeDir, value.slice(2));
  return path.resolve(value);
}

export function browserProfileDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): string | null {
  const configured = env.COS_BROWSER_USER_DATA_DIR?.trim();
  return configured ? expandHome(configured, homeDir) : null;
}

/** Optional Chromium profile directory inside the selected user-data root, e.g. `Profile 86`. */
export function browserProfileDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.COS_BROWSER_PROFILE_DIRECTORY?.trim();
  if (!configured) return null;
  // Chromium profile directory names are one path segment. Refuse path traversal and switches.
  if (configured.startsWith('-') || configured.includes('/') || configured.includes('\\') || configured.includes('\0')) return null;
  return configured.slice(0, 120);
}

/**
 * Optional production profile root.
 *
 * Upstream CoS intentionally defaults to Electron's ordinary per-user directory. COS_HOME is an
 * owner fork escape hatch for running two legitimate, isolated local identities side by side.
 * It is deliberately explicit rather than deriving a path from a display label: launchers can
 * then show the exact directory they are about to use and there is no hidden account mapping.
 */
export function resolveProfilePaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): ElectronProfilePaths | null {
  const configured = env.COS_HOME?.trim();
  if (!configured) return null;
  const userData = expandHome(configured, homeDir);
  return { userData, sessionData: path.join(userData, 'electron-session') };
}

/** Must run before requestSingleInstanceLock() so Electron's process singleton is profile-scoped. */
export function applyProfilePaths(
  electronApp: { setPath(name: 'userData' | 'sessionData', value: string): void },
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): ElectronProfilePaths | null {
  const resolved = resolveProfilePaths(env, homeDir);
  if (!resolved) return null;
  mkdirSync(resolved.userData, { recursive: true, mode: 0o700 });
  mkdirSync(resolved.sessionData, { recursive: true, mode: 0o700 });
  electronApp.setPath('userData', resolved.userData);
  electronApp.setPath('sessionData', resolved.sessionData);
  return resolved;
}

export function profileLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.COS_PROFILE?.trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 48) || null;
}

/**
 * Production multi-profile bridge ports. CLF_BRIDGE_PORTS remains as the upstream test hook;
 * COS_BRIDGE_PORTS is the explicit owner-facing setting and takes precedence when present.
 */
export function bridgePorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.COS_BRIDGE_PORTS?.trim() || env.CLF_BRIDGE_PORTS?.trim();
  if (!raw) return [...DEFAULT_BRIDGE_PORTS];
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 65535);
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : [...DEFAULT_BRIDGE_PORTS];
}

/**
 * The browser extension is a production artifact and must never inherit CLF_BRIDGE_PORTS: that
 * variable intentionally belongs to parallel test processes, where port 0 asks the OS to choose
 * an ephemeral listener. Only the explicit owner-facing COS_BRIDGE_PORTS may change what a
 * materialized extension scans.
 */
export function extensionBridgePorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.COS_BRIDGE_PORTS?.trim();
  return raw ? bridgePorts({ COS_BRIDGE_PORTS: raw }) : [...DEFAULT_BRIDGE_PORTS];
}
