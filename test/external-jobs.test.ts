import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const stage = {
  created: [{ id: 'worker-1' }],
  becamePrime: true,
  runId: 'run-external',
  commit: vi.fn(),
  rollback: vi.fn()
};
const stageSpawn = vi.fn((_request: { workers: Array<{ task: string }> }) => stage);
const persistCriticalSwarmNow = vi.fn(async () => true);
const requestWorkerBootstraps = vi.fn();
let swarmListener: (() => void) | null = null;
const onSwarmChange = vi.fn((listener: () => void) => {
  swarmListener = listener;
  return vi.fn();
});
const swarmStateForCaller = vi.fn<() => { enabled: boolean; running: boolean; retainedHistory: boolean; agents: Array<{ runId: string; id: string; state: string; result: string | null }> }>(
  () => ({ enabled: true, running: true, retainedHistory: false, agents: [] })
);

vi.mock('../src/main/agents.js', () => ({
  stageSpawn,
  persistCriticalSwarmNow,
  requestWorkerBootstraps,
  onSwarmChange,
  swarmStateForCaller
}));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ multiAgent: { enabled: true } })
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

const {
  EXTERNAL_PRIME_CONVERSATION_ID,
  dispatchExternalJob,
  externalJobDirsFromArgv,
  isExternalJobLaunch
} = await import('../src/main/external-jobs.js');

let dir = '';
beforeEach(async () => {
  vi.clearAllMocks();
  swarmStateForCaller.mockReturnValue({ enabled: true, running: true, retainedHistory: false, agents: [] });
  dir = await makeTempDir('cos-external-job-');
});
afterEach(async () => { await removeTempDir(dir); });

describe('external subagent jobs', () => {
  it('parses both supported argv forms without duplicates', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    expect(externalJobDirsFromArgv(['app', '--cos-subagent-job', a, `--cos-subagent-job=${b}`, `--cos-subagent-job=${a}`]))
      .toEqual([path.resolve(a), path.resolve(b)]);
    expect(isExternalJobLaunch(['app', '--cos-subagent-job', a])).toBe(true);
    expect(isExternalJobLaunch(['app'])).toBe(false);
  });

  it('never mutates process browser identity for an external job', async () => {
    const priorProfile = process.env.COS_BROWSER_PROFILE_DIRECTORY;
    const priorUserData = process.env.COS_BROWSER_USER_DATA_DIR;
    try {
      process.env.COS_BROWSER_PROFILE_DIRECTORY = 'Profile 173';
      process.env.COS_BROWSER_USER_DATA_DIR = '/custom/chrome';
      await fs.writeFile(path.join(dir, 'prompt.md'), '# Work\n');
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ browserProfileDirectory: 'Profile 173', browserUserDataDir: '/custom/chrome' }));
      await dispatchExternalJob(dir);
      expect(process.env.COS_BROWSER_PROFILE_DIRECTORY).toBe('Profile 173');
      expect(process.env.COS_BROWSER_USER_DATA_DIR).toBe('/custom/chrome');
    } finally {
      if (priorProfile === undefined) delete process.env.COS_BROWSER_PROFILE_DIRECTORY;
      else process.env.COS_BROWSER_PROFILE_DIRECTORY = priorProfile;
      if (priorUserData === undefined) delete process.env.COS_BROWSER_USER_DATA_DIR;
      else process.env.COS_BROWSER_USER_DATA_DIR = priorUserData;
    }
  });

  it('fails closed before staging when a legacy job asks a running app to change browser identity', async () => {
    const priorProfile = process.env.COS_BROWSER_PROFILE_DIRECTORY;
    const priorUserData = process.env.COS_BROWSER_USER_DATA_DIR;
    try {
      process.env.COS_BROWSER_PROFILE_DIRECTORY = 'Profile 86';
      process.env.COS_BROWSER_USER_DATA_DIR = '/owner/chrome';
      await fs.writeFile(path.join(dir, 'prompt.md'), '# Work\n');
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ browserProfileDirectory: 'Profile 173', browserUserDataDir: '/custom/chrome' }));
      expect(await dispatchExternalJob(dir)).toBeNull();
      expect(stageSpawn).not.toHaveBeenCalled();
      expect(process.env.COS_BROWSER_PROFILE_DIRECTORY).toBe('Profile 86');
      expect(process.env.COS_BROWSER_USER_DATA_DIR).toBe('/owner/chrome');
      const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
      expect(done).toMatchObject({ status: 'error' });
      expect(done.error).toMatch(/browser identity does not match/i);
    } finally {
      if (priorProfile === undefined) delete process.env.COS_BROWSER_PROFILE_DIRECTORY;
      else process.env.COS_BROWSER_PROFILE_DIRECTORY = priorProfile;
      if (priorUserData === undefined) delete process.env.COS_BROWSER_USER_DATA_DIR;
      else process.env.COS_BROWSER_USER_DATA_DIR = priorUserData;
    }
  });

  it('durably admits one worker and records the broker identity', async () => {
    await fs.writeFile(path.join(dir, 'prompt.md'), '# Do the requested work\n');
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ jobId: 'abc', model: 'gpt-5.6', reasoningEffort: 'high' }));

    const result = await dispatchExternalJob(dir);
    expect(result).toMatchObject({ runId: 'run-external', workerId: 'worker-1' });
    expect(stageSpawn).toHaveBeenCalledWith(expect.objectContaining({
      caller: { conversationId: EXTERNAL_PRIME_CONVERSATION_ID },
      workers: [expect.objectContaining({ model: 'gpt-5.6', reasoning_effort: 'high' })]
    }));
    const worker = stageSpawn.mock.calls[0]![0].workers[0]!;
    expect(worker.task.split('\n')[0]).toBe('@Chat On Steroids Core');
    expect(worker.task).toContain('# Do the requested work');
    expect(worker.task).toContain('--- BEGIN EXTERNAL JOB ---');
    expect(worker.task).not.toContain(`Read the complete instructions from ${path.join(dir, 'prompt.md')}.`);
    expect(persistCriticalSwarmNow).toHaveBeenCalledTimes(1);
    expect(stage.commit).toHaveBeenCalledTimes(1);
    expect(stage.rollback).not.toHaveBeenCalled();
    expect(requestWorkerBootstraps).toHaveBeenCalledWith(['worker-1'], 'run-external');
    const dispatch = JSON.parse(await fs.readFile(path.join(dir, 'dispatch.json'), 'utf8'));
    expect(dispatch).toMatchObject({ status: 'dispatched', runId: 'run-external', workerId: 'worker-1' });
  });


  it('fails closed into done.json when prompt.md is absent', async () => {
    expect(await dispatchExternalJob(dir)).toBeNull();
    const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
    expect(done.status).toBe('error');
    expect(done.error).toMatch(/prompt\.md|ENOENT/i);
    expect(stageSpawn).not.toHaveBeenCalled();
  });

  it('writes done.json when a dispatched worker fails before reporting', async () => {
    await fs.writeFile(path.join(dir, 'prompt.md'), '# Do the requested work\n');
    await dispatchExternalJob(dir);

    swarmStateForCaller.mockReturnValue({
      enabled: true,
      running: true,
      retainedHistory: false,
      agents: [{ runId: 'run-external', id: 'worker-1', state: 'failed', result: 'the chat did not report back' }]
    });
    swarmListener?.();

    await vi.waitFor(async () => {
      const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
      expect(done).toMatchObject({ status: 'error', error: 'the chat did not report back' });
    });
  });

  it('does not overwrite a completion file when the worker stops', async () => {
    await fs.writeFile(path.join(dir, 'prompt.md'), '# Do the requested work\n');
    await dispatchExternalJob(dir);
    await fs.writeFile(path.join(dir, 'done.json'), JSON.stringify({ status: 'done', finishedAt: 'now' }));

    swarmStateForCaller.mockReturnValue({
      enabled: true,
      running: true,
      retainedHistory: false,
      agents: [{ runId: 'run-external', id: 'worker-1', state: 'sleeping', result: 'finished' }]
    });
    swarmListener?.();

    await vi.waitFor(async () => {
      const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
      expect(done).toEqual({ status: 'done', finishedAt: 'now' });
    });
  });

  it('submits done.json and response.md when a worker for a synthetic external prime completes with a result', async () => {
    await fs.writeFile(path.join(dir, 'prompt.md'), '# What is 12345 + 54321?\n');
    await dispatchExternalJob(dir);

    swarmStateForCaller.mockReturnValue({
      enabled: true,
      running: true,
      retainedHistory: false,
      agents: [{
        runId: 'run-external',
        id: 'worker-1',
        state: 'sleeping',
        result: '12345 + 54321 = **66666**.\n\nNon ho potuto scrivere `response.md` e `done.json`: Chat On Steroids Core ha fallito due volte con `tunnel_client_not_seen`'
      }]
    });
    swarmListener?.();

    await vi.waitFor(async () => {
      const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
      expect(done.status).toBe('done');
      expect(done.finishedAt).toBeDefined();
    });

    const response = await fs.readFile(path.join(dir, 'response.md'), 'utf8');
    expect(response).toContain('66666');
    expect(response).not.toContain('tunnel_client_not_seen');
  });

  it('preserves an existing response.md and writes done.json when worker stops', async () => {
    await fs.writeFile(path.join(dir, 'prompt.md'), '# What is 12345 + 54321?\n');
    await dispatchExternalJob(dir);
    await fs.writeFile(path.join(dir, 'response.md'), 'pre-written response\n');

    swarmStateForCaller.mockReturnValue({
      enabled: true,
      running: true,
      retainedHistory: false,
      agents: [{
        runId: 'run-external',
        id: 'worker-1',
        state: 'finished',
        result: 'new result'
      }]
    });
    swarmListener?.();

    await vi.waitFor(async () => {
      const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
      expect(done.status).toBe('done');
    });

    const response = await fs.readFile(path.join(dir, 'response.md'), 'utf8');
    expect(response).toBe('pre-written response\n');
  });

  it('settles concurrent dispatch failures without colliding temporary files', async () => {
    const [first, second] = await Promise.all([dispatchExternalJob(dir), dispatchExternalJob(dir)]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
    expect(done).toMatchObject({ status: 'error' });
    expect(done.error).toMatch(/prompt\.md|ENOENT/i);
  });
});
