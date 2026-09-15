import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  onSwarmChange,
  persistCriticalSwarmNow,
  requestWorkerBootstraps,
  stageSpawn,
  swarmStateForCaller,
  type SpawnResult
} from './agents.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';

export const EXTERNAL_PRIME_CONVERSATION_ID = 'local:chat-on-steroids-subagent:v1';
export const EXTERNAL_JOB_ARG = '--cos-subagent-job';
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const INLINE_PROMPT_BYTES = 64 * 1024;

interface TrackedExternalJob {
  jobDir: string;
  runId: string;
  workerId: string;
}

const trackedExternalJobs = new Map<string, TrackedExternalJob>();

function trackedJobKey(runId: string, workerId: string): string {
  return `${runId}:${workerId}`;
}

const metaSchema = z.object({
  jobId: z.string().min(1).max(160).optional(),
  model: z.string().trim().max(80).nullable().optional(),
  reasoningEffort: z.enum(['pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable().optional(),
  label: z.string().trim().max(60).optional(),
  browserProfileDirectory: z.string().trim().min(1).max(120).regex(/^[^\/\\-][^\/\\]*$/).optional(),
  browserUserDataDir: z.string().trim().min(1).max(500).optional(),
  connectorName: z.string().trim().max(120).optional()
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
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
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
    logWarn(`external subagent: could not write failure state for ${path.basename(jobDir)} — ${writeError instanceof Error ? writeError.message : String(writeError)}`);
  }
}

function sanitizeWorkerResult(raw: string): string {
  const text = raw.trim();
  const stripped = text.replace(
    /\n\n+(?:(?:Non ho potuto scrivere|Non sono riuscito a scrivere|I was unable to write|I could not write|Unable to write|Failed to write)[^\n]*(?:response\.md|done\.json)[^\n]*(?:tunnel_client_not_seen|Chat On Steroids Core|connettore|filesystem)[^]*)$/i,
    ''
  ).trim();
  return stripped || text;
}

async function reconcileExternalJobs(): Promise<void> {
  for (const [key, tracked] of trackedExternalJobs) {
    const donePath = path.join(tracked.jobDir, 'done.json');
    try {
      await fs.access(donePath);
      trackedExternalJobs.delete(key);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn(`external subagent: could not inspect completion state for ${path.basename(tracked.jobDir)} — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    let worker;
    try {
      worker = swarmStateForCaller({ conversationId: EXTERNAL_PRIME_CONVERSATION_ID }).agents.find(
        agent => agent.runId === tracked.runId && agent.id === tracked.workerId
      );
    } catch {
      continue;
    }
    if (!worker || !['failed', 'finished', 'sleeping'].includes(worker.state)) continue;

    trackedExternalJobs.delete(key);
    if (worker.state !== 'failed' && typeof worker.result === 'string' && worker.result.trim().length > 0) {
      try {
        const responsePath = path.join(tracked.jobDir, 'response.md');
        let responseExists = false;
        try {
          const stat = await fs.stat(responsePath);
          responseExists = stat.size > 0;
        } catch {
          responseExists = false;
        }
        if (!responseExists) {
          const sanitized = sanitizeWorkerResult(worker.result);
          await fs.writeFile(responsePath, `${sanitized}\n`, { encoding: 'utf8', mode: 0o600 });
        }
        const meta = await readMeta(tracked.jobDir).catch(() => ({} as z.infer<typeof metaSchema>));
        await writeJsonAtomic(donePath, {
          status: 'done',
          finishedAt: new Date().toISOString(),
          receipt: {
            transport: 'legacy-electron',
            host: os.hostname(),
            requested: {
              connectorName: meta.connectorName || 'Chat On Steroids Core',
              browserProfileDirectory: meta.browserProfileDirectory || 'Profile 173'
            },
            observed: {
              runId: tracked.runId,
              workerId: tracked.workerId,
              conversationId: worker.id
            }
          }
        });
        logInfo(`external subagent: completed ${path.basename(tracked.jobDir)} via durable write-back`);
        continue;
      } catch (writeError) {
        logWarn(`external subagent: durable write-back failed for ${path.basename(tracked.jobDir)} — ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    }
    await failJob(
      tracked.jobDir,
      worker.result || (worker.state === 'failed'
        ? 'Chat On Steroids worker failed before reporting back'
        : 'Chat On Steroids worker stopped without completing the external job')
    );
  }
}

onSwarmChange(() => {
  void reconcileExternalJobs().catch(error => {
    logWarn(`external subagent: could not reconcile worker lifecycle — ${error instanceof Error ? error.message : String(error)}`);
  });
});

function workerTask(promptPath: string, responsePath: string, donePath: string, inlinePrompt: string | null): string {
  const input = inlinePrompt === null
    ? [`Read the complete instructions from ${promptPath}.`]
    : ['The complete external job is included below. Do not re-read prompt.md unless you need to verify corruption.',
      '--- BEGIN EXTERNAL JOB ---', inlinePrompt, '--- END EXTERNAL JOB ---'];
  return [
    '@Chat On Steroids Core',
    'You are a Chat On Steroids worker executing a file-backed external-agent job.',
    ...input,
    'Execute that job faithfully using the tools available to you. Preserve its requested scope; do not broaden it into an unrelated audit.',
    'Start the requested work immediately. Do not inspect Chat On Steroids internals, broker state, logs, profile configuration, or this job protocol unless the external job itself asks for that or an actual tool call fails.',
    'For filesystem inventory, do not recursively walk a large tree unless recursive/exhaustive traversal was explicitly requested. If depth is unspecified, inspect direct children and summarize large subtrees cheaply.',
    'Do not spawn nested workers.',
    `Write the complete final result to ${responsePath}.`,
    `Only after response.md is complete, atomically write ${donePath} as JSON with {"status":"done","finishedAt":"<ISO-8601>"}.`,
    'If the job cannot be completed, still write the best useful result to response.md and write done.json with status "error" and a concise error field.',
    'The calling agent waits on these files, so do not leave the result only in the ChatGPT conversation.'
  ].join('\n');
}

async function durableSpawn(jobDir: string, promptPath: string, responsePath: string, donePath: string, inlinePrompt: string | null): Promise<SpawnResult> {
  if (!getConfig().multiAgent.enabled) throw new Error('Chat On Steroids multi-agent mode is disabled');
  const meta = await readMeta(jobDir);
  const staged = stageSpawn({
    caller: { conversationId: EXTERNAL_PRIME_CONVERSATION_ID },
    workers: [{
      label: meta.label || `External ${meta.jobId || path.basename(jobDir)}`.slice(0, 60),
      task: workerTask(promptPath, responsePath, donePath, inlinePrompt),
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
  if (meta.browserUserDataDir) process.env.COS_BROWSER_USER_DATA_DIR = meta.browserUserDataDir;
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
        trackedExternalJobs.set(trackedJobKey(existing.runId, existing.workerId), {
          jobDir,
          runId: existing.runId,
          workerId: existing.workerId
        });
        void reconcileExternalJobs();
        return { jobDir, promptPath, responsePath, donePath, runId: existing.runId, workerId: existing.workerId };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    const stat = await fs.stat(promptPath);
    if (!stat.isFile()) throw new Error('prompt.md is not a regular file');
    if (stat.size === 0) throw new Error('prompt.md is empty');
    if (stat.size > MAX_PROMPT_BYTES) throw new Error(`prompt.md exceeds ${MAX_PROMPT_BYTES} bytes`);

    // Most external jobs are small. Inline those instructions into the bootstrap so the worker
    // can start with its first useful tool call instead of spending a round trip reading the
    // same prompt file. Large prompts retain the file-backed path to avoid blowing the browser
    // message limit.
    const inlinePrompt = stat.size <= INLINE_PROMPT_BYTES ? await fs.readFile(promptPath, 'utf8') : null;
    const spawned = await durableSpawn(jobDir, promptPath, responsePath, donePath, inlinePrompt);
    const worker = spawned.created[0];
    if (!worker) throw new Error('Chat On Steroids did not create a worker');
    await writeJsonAtomic(dispatchPath, {
      status: 'dispatched',
      runId: spawned.runId,
      workerId: worker.id,
      dispatchedAt: new Date().toISOString()
    });
    trackedExternalJobs.set(trackedJobKey(spawned.runId, worker.id), {
      jobDir,
      runId: spawned.runId,
      workerId: worker.id
    });
    logInfo(`external subagent: dispatched ${path.basename(jobDir)} as ${spawned.runId}:${worker.id}`);
    return { jobDir, promptPath, responsePath, donePath, runId: spawned.runId, workerId: worker.id };
  } catch (error) {
    logWarn(`external subagent: ${path.basename(jobDir)} failed to dispatch — ${error instanceof Error ? error.message : String(error)}`);
    await failJob(jobDir, error);
    return null;
  }
}
