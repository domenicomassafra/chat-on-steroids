/**
 * Materialize the app-owned external subagent runtime into stable per-user storage.
 *
 * The DStack skill is intentionally only a facade: executable browser/runtime ownership lives
 * with Chat On Steroids. Packaged resources are immutable/update-scoped, so copy the bundled
 * runtime transactionally into userData and publish that stable path through
 * COS_SUBAGENT_SKILL_ROOT for child processes/connectors spawned by this app.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const RUNTIME_DIR = 'external-subagent-skill';
const FINGERPRINT_FILE = '.chat-on-steroids-source';
const REQUIRED_FILES = ['SKILL.md', 'bin/cos-subagent.mjs', 'config/profile.json'] as const;

function regularFileWithoutSymlink(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function validExternalSubagentRuntime(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    return REQUIRED_FILES.every((relative) => regularFileWithoutSymlink(path.join(dir, relative)));
  } catch {
    return false;
  }
}

function treeFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, relativeDir = ''): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`External subagent runtime contains symlink: ${relative}`);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported external subagent runtime entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function recordedFingerprint(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, FINGERPRINT_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function recoverInterrupted(stable: string, stage: string, backup: string): void {
  if (validExternalSubagentRuntime(stable)) return;
  if (validExternalSubagentRuntime(backup)) {
    if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
    renameSync(backup, stable);
    rmSync(stage, { recursive: true, force: true });
    return;
  }
  if (validExternalSubagentRuntime(stage) && recordedFingerprint(stage) !== null) {
    if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
    renameSync(stage, stable);
  }
}

export function materializeExternalSubagentRuntime(): string | null {
  if (!app.isPackaged) {
    const candidates = [path.join(app.getAppPath(), RUNTIME_DIR), path.join(process.cwd(), RUNTIME_DIR)];
    const source = candidates.find(validExternalSubagentRuntime) ?? null;
    if (source) process.env.COS_SUBAGENT_SKILL_ROOT = source;
    return source;
  }

  const bundled = path.join(process.resourcesPath, RUNTIME_DIR);
  const stable = path.join(app.getPath('userData'), RUNTIME_DIR);
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  mkdirSync(path.dirname(stable), { recursive: true });
  recoverInterrupted(stable, stage, backup);

  if (!validExternalSubagentRuntime(bundled)) {
    if (validExternalSubagentRuntime(stable)) {
      process.env.COS_SUBAGENT_SKILL_ROOT = stable;
      return stable;
    }
    return null;
  }

  const fingerprint = treeFingerprint(bundled);
  if (validExternalSubagentRuntime(stable) && recordedFingerprint(stable) === fingerprint) {
    process.env.COS_SUBAGENT_SKILL_ROOT = stable;
    return stable;
  }

  rmSync(stage, { recursive: true, force: true });
  let oldMoved = false;
  try {
    cpSync(bundled, stage, { recursive: true, force: true, preserveTimestamps: true });
    if (!validExternalSubagentRuntime(stage)) throw new Error('Staged external subagent runtime is incomplete');
    writeFileSync(path.join(stage, FINGERPRINT_FILE), `${fingerprint}\n`, { encoding: 'utf8', mode: 0o600 });
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(stable)) {
      if (validExternalSubagentRuntime(stable)) {
        renameSync(stable, backup);
        oldMoved = true;
      } else {
        rmSync(stable, { recursive: true, force: true });
      }
    }
    try {
      renameSync(stage, stable);
    } catch (error) {
      if (oldMoved && !existsSync(stable) && existsSync(backup)) renameSync(backup, stable);
      throw error;
    }
    if (oldMoved) rmSync(backup, { recursive: true, force: true });
    process.env.COS_SUBAGENT_SKILL_ROOT = stable;
    return stable;
  } catch {
    if (validExternalSubagentRuntime(stable)) {
      rmSync(stage, { recursive: true, force: true });
      process.env.COS_SUBAGENT_SKILL_ROOT = stable;
      return stable;
    }
    return null;
  }
}

