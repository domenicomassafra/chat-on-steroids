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
const stageSpawn = vi.fn(() => stage);
const persistCriticalSwarmNow = vi.fn(async () => true);
const requestWorkerBootstraps = vi.fn();

vi.mock('../src/main/agents.js', () => ({
  stageSpawn,
  persistCriticalSwarmNow,
  requestWorkerBootstraps
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

  it('durably admits one worker and records the broker identity', async () => {
    await fs.writeFile(path.join(dir, 'prompt.md'), '# Do the requested work\n');
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ jobId: 'abc', model: 'gpt-5.6', reasoningEffort: 'high' }));

    const result = await dispatchExternalJob(dir);
    expect(result).toMatchObject({ runId: 'run-external', workerId: 'worker-1' });
    expect(stageSpawn).toHaveBeenCalledWith(expect.objectContaining({
      caller: { conversationId: EXTERNAL_PRIME_CONVERSATION_ID },
      workers: [expect.objectContaining({ model: 'gpt-5.6', reasoning_effort: 'high' })]
    }));
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
});
