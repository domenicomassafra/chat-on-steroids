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

  it('propagates browser profile directory and user data dir to the process environment', async () => {
    const priorProfile = process.env.COS_BROWSER_PROFILE_DIRECTORY;
    const priorUserData = process.env.COS_BROWSER_USER_DATA_DIR;
    try {
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

  it('settles concurrent dispatch failures without colliding temporary files', async () => {
    const [first, second] = await Promise.all([dispatchExternalJob(dir), dispatchExternalJob(dir)]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    const done = JSON.parse(await fs.readFile(path.join(dir, 'done.json'), 'utf8'));
    expect(done).toMatchObject({ status: 'error' });
    expect(done.error).toMatch(/prompt\.md|ENOENT/i);
  });
});
