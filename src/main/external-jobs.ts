import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import {
  persistCriticalSwarmNow,
  requestWorkerBootstraps,
  stageSpawn,
  type SpawnResult
} from './agents.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export const EXTERNAL_PRIME_CONVERSATION_ID = 'local:chat-on-steroids-subagent:v1';
export const EXTERNAL_JOB_ARG = '--cos-subagent-job';
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

const metaSchema = z.object({
  jobId: z.string().min(1).max(160).optional(),
  model: z.string().trim().max(80).nullable().optional(),
  reasoningEffort: z.enum(['pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable().optional(),
  label: z.string().trim().max(60).optional(),
  browserProfileDirectory: z.string().trim().min(1).max(120).regex(/^[^\/\\-][^\/\\]*$/).optional()
}).passthrough();

export interface ExternalJobDispatch {
  jobDir: string;
  promptPath: string;
  responsePath: string;
  donePath: string;
  runId: string;
  workerId: string;
}

export function externalJobDirsFromArgv(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';
    if (value === EXTERNAL_JOB_ARG) {
      const next = argv[index + 1]?.trim();
      if (next) result.push(path.resolve(next));
      index += 1;
      continue;
    }
    const prefix = `${EXTERNAL_JOB_ARG}=`;
    if (value.startsWith(prefix) && value.slice(prefix.length).trim()) {
      result.push(path.resolve(value.slice(prefix.length).trim()));
    }
  }
  return [...new Set(result)];
}

export function isExternalJobLaunch(argv: readonly string[]): boolean {
  return externalJobDirsFromArgv(argv).length > 0;
}

async function readMeta(jobDir: string): Promise<z.infer<typeof metaSchema>> {
  try {
    const raw = await fs.readFile(path.join(jobDir, 'meta.json'), 'utf8');
    return metaSchema.parse(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error('meta.json is not valid Chat On Steroids job metadata');
    }
    throw error;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, target);
}

async function failJob(jobDir: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await writeJsonAtomic(path.join(jobDir, 'done.json'), {
      status: 'error',
      error: message,
      finishedAt: new Date().toISOString()
    });
  } catch (writeError) {
    logWarn(`external subagent: could not write failure state for ${jobDir} — ${writeError instanceof Error ? writeError.message : String(writeError)}`);
  }
}

function workerTask(promptPath: string, responsePath: string, donePath: string): string {
  return [
    '@Chat On Steroids Core',
    'You are a Chat On Steroids worker executing a file-backed external-agent job.',
    `Read the complete instructions from ${promptPath}.`,
    'Execute them fully using the tools available to you.',
    `Write the complete final result to ${responsePath}.`,
    `Only after response.md is complete, atomically write ${donePath} as JSON with {"status":"done","finishedAt":"<ISO-8601>"}.`,
    'If the job cannot be completed, still write the best useful result to response.md and write done.json with status "error" and a concise error field.',
    'The calling agent waits on these files, so do not leave the result only in the ChatGPT conversation.'
  ].join('\n');
}

async function durableSpawn(jobDir: string, promptPath: string, responsePath: string, donePath: string): Promise<SpawnResult> {
  if (!getConfig().multiAgent.enabled) throw new Error('Chat On Steroids multi-agent mode is disabled');
  const meta = await readMeta(jobDir);
  const staged = stageSpawn({
    caller: { conversationId: EXTERNAL_PRIME_CONVERSATION_ID },
    workers: [{
      label: meta.label || `External ${meta.jobId || path.basename(jobDir)}`.slice(0, 60),
      task: workerTask(promptPath, responsePath, donePath),
      model: meta.model,
      reasoning_effort: meta.reasoningEffort
    }]
  });
  try {
    if (!(await persistCriticalSwarmNow())) throw new Error('Chat On Steroids durable agent store is not ready');
    staged.commit();
  } catch (error) {
    staged.rollback();
    throw error;
  }
  if (meta.browserProfileDirectory) process.env.COS_BROWSER_PROFILE_DIRECTORY = meta.browserProfileDirectory;
  requestWorkerBootstraps(staged.created.map(worker => worker.id), staged.runId);
  return staged;
}

export async function dispatchExternalJob(rawJobDir: string): Promise<ExternalJobDispatch | null> {
  const jobDir = path.resolve(rawJobDir);
  const promptPath = path.join(jobDir, 'prompt.md');
  const responsePath = path.join(jobDir, 'response.md');
  const donePath = path.join(jobDir, 'done.json');
  try {
    const dispatchPath = path.join(jobDir, 'dispatch.json');
    try {
      const existing = JSON.parse(await fs.readFile(dispatchPath, 'utf8')) as { runId?: unknown; workerId?: unknown };
      if (typeof existing.runId === 'string' && typeof existing.workerId === 'string') {
        return { jobDir, promptPath, responsePath, donePath, runId: existing.runId, workerId: existing.workerId };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    const stat = await fs.stat(promptPath);
    if (!stat.isFile()) throw new Error('prompt.md is not a regular file');
    if (stat.size === 0) throw new Error('prompt.md is empty');
    if (stat.size > MAX_PROMPT_BYTES) throw new Error(`prompt.md exceeds ${MAX_PROMPT_BYTES} bytes`);

    const spawned = await durableSpawn(jobDir, promptPath, responsePath, donePath);
    const worker = spawned.created[0];
    if (!worker) throw new Error('Chat On Steroids did not create a worker');
    await writeJsonAtomic(dispatchPath, {
      status: 'dispatched',
      runId: spawned.runId,
      workerId: worker.id,
      dispatchedAt: new Date().toISOString()
    });
    logInfo(`external subagent: dispatched ${jobDir} as ${spawned.runId}:${worker.id}`);
    return { jobDir, promptPath, responsePath, donePath, runId: spawned.runId, workerId: worker.id };
  } catch (error) {
    logWarn(`external subagent: ${jobDir} failed to dispatch — ${error instanceof Error ? error.message : String(error)}`);
    await failJob(jobDir, error);
    return null;
  }
}
