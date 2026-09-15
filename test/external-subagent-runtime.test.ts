import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

let base: string | null = null;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const originalRoot = process.env.COS_SUBAGENT_SKILL_ROOT;

async function makeRuntime(root: string, marker = 'current'): Promise<void> {
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'SKILL.md'), `# ${marker}\n`);
  await fs.writeFile(path.join(root, 'bin', 'cos-subagent.mjs'), `// ${marker}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'config', 'profile.json'), JSON.stringify({ marker }));
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('electron');
  if (base) await removeTempDir(base);
  base = null;
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: originalResourcesPath });
  if (originalRoot === undefined) delete process.env.COS_SUBAGENT_SKILL_ROOT;
  else process.env.COS_SUBAGENT_SKILL_ROOT = originalRoot;
});

it('materializes the packaged app-owned runtime and publishes COS_SUBAGENT_SKILL_ROOT', async () => {
  base = await makeTempDir('cos-external-runtime-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'external-subagent-skill');
  const userData = path.join(base, 'user-data');
  await makeRuntime(bundled);
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: () => userData, getAppPath: () => base! } }));

  const { materializeExternalSubagentRuntime, validExternalSubagentRuntime } = await import('../src/main/external-subagent-runtime.js');
  const stable = path.join(userData, 'external-subagent-skill');
  expect(materializeExternalSubagentRuntime()).toBe(stable);
  expect(process.env.COS_SUBAGENT_SKILL_ROOT).toBe(stable);
  expect(validExternalSubagentRuntime(stable)).toBe(true);
  expect(await fs.readFile(path.join(stable, 'SKILL.md'), 'utf8')).toBe('# current\n');
});

it('refreshes atomically and rejects symlinked required runtime files', async () => {
  base = await makeTempDir('cos-external-runtime-refresh-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'external-subagent-skill');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'external-subagent-skill');
  await makeRuntime(bundled, 'v1');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: () => userData, getAppPath: () => base! } }));

  const mod = await import('../src/main/external-subagent-runtime.js');
  expect(mod.materializeExternalSubagentRuntime()).toBe(stable);
  await fs.writeFile(path.join(bundled, 'SKILL.md'), '# v2\n');
  expect(mod.materializeExternalSubagentRuntime()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'SKILL.md'), 'utf8')).toBe('# v2\n');

  await fs.rm(path.join(stable, 'bin', 'cos-subagent.mjs'));
  await fs.symlink(path.join(stable, 'SKILL.md'), path.join(stable, 'bin', 'cos-subagent.mjs'));
  expect(mod.validExternalSubagentRuntime(stable)).toBe(false);
});

it('keeps the last known good app-owned runtime when the packaged source is damaged', async () => {
  base = await makeTempDir('cos-external-runtime-fallback-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'external-subagent-skill');
  const userData = path.join(base, 'user-data');
  await makeRuntime(bundled, 'good');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: () => userData, getAppPath: () => base! } }));

  const { materializeExternalSubagentRuntime } = await import('../src/main/external-subagent-runtime.js');
  const stable = materializeExternalSubagentRuntime()!;
  await fs.rm(path.join(bundled, 'config', 'profile.json'));
  expect(materializeExternalSubagentRuntime()).toBe(stable);
  expect(process.env.COS_SUBAGENT_SKILL_ROOT).toBe(stable);
});

