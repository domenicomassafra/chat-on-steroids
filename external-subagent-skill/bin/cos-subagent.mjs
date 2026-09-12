#!/usr/bin/env node
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(scriptDir);
const profilePath = path.join(skillDir, 'config', 'profile.json');

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  cos-subagent run <prompt.md> [--async] [--model <slug>] [--reasoning <level>] [--job-root <dir>] [--timeout-seconds <n>]
  cos-subagent status <job-dir>
  cos-subagent wait|join <job-dir> [--timeout-seconds <n>]`);
  process.exit(2);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(args, name) { return args.includes(name); }
function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function exists(file) { try { await fs.access(file, fsConstants.F_OK); return true; } catch { return false; } }
function stamp() {
  const iso = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
  return `${iso}-${randomBytes(4).toString('hex')}`;
}
async function atomicJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
async function profile() {
  const value = await readJson(profilePath);
  if (value.failClosed && (!value.profileDirectory || !value.appExecutable)) {
    throw new Error('Authorized Chat On Steroids browser profile is not fully configured');
  }
  return value;
}
async function launch(jobDir, cfg) {
  const executable = expandHome(process.env.COS_APP_EXECUTABLE || cfg.appExecutable);
  if (!executable) throw new Error('Chat On Steroids executable is not configured');
  if (path.isAbsolute(executable) && !(await exists(executable))) throw new Error(`Chat On Steroids executable not found: ${executable}`);
  const child = spawn(executable, [`--cos-subagent-job=${jobDir}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env }
  });
  child.unref();
}
async function status(jobDir) {
  const donePath = path.join(jobDir, 'done.json');
  const dispatchPath = path.join(jobDir, 'dispatch.json');
  if (await exists(donePath)) return { state: 'done', done: await readJson(donePath), jobDir };
  if (await exists(dispatchPath)) return { state: 'dispatched', dispatch: await readJson(dispatchPath), jobDir };
  if (await exists(path.join(jobDir, 'prompt.md'))) return { state: 'queued', jobDir };
  return { state: 'missing', jobDir };
}
async function wait(jobDir, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await exists(path.join(jobDir, 'done.json'))) {
      const done = await readJson(path.join(jobDir, 'done.json'));
      const response = await fs.readFile(path.join(jobDir, 'response.md'), 'utf8').catch(() => '');
      if (done.status === 'done') {
        process.stdout.write(response);
        if (response && !response.endsWith('\n')) process.stdout.write('\n');
        return 0;
      }
      if (response) process.stdout.write(response.endsWith('\n') ? response : `${response}\n`);
      console.error(done.error || 'Chat On Steroids worker reported an error');
      return 1;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.error(`Timed out waiting for ${jobDir}`);
  return 124;
}

const [command, target, ...args] = process.argv.slice(2);
if (!command || !target) usage();

try {
  if (command === 'status') {
    console.log(JSON.stringify(await status(path.resolve(target)), null, 2));
    process.exit(0);
  }
  if (command === 'wait' || command === 'join') {
    const timeout = Number.parseInt(option(args, '--timeout-seconds') || '3600', 10);
    process.exit(await wait(path.resolve(target), Number.isFinite(timeout) && timeout > 0 ? timeout : 3600));
  }
  if (command !== 'run') usage(`Unknown command: ${command}`);

  const sourcePrompt = path.resolve(target);
  const sourceStat = await fs.stat(sourcePrompt);
  if (!sourceStat.isFile()) throw new Error(`Prompt is not a regular file: ${sourcePrompt}`);
  const cfg = await profile();
  const root = path.resolve(option(args, '--job-root') || path.join(path.dirname(sourcePrompt), '.chatonsteroids', 'jobs'));
  const jobId = stamp();
  const jobDir = path.join(root, jobId);
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePrompt, path.join(jobDir, 'prompt.md'));
  await atomicJson(path.join(jobDir, 'meta.json'), {
    jobId,
    sourcePrompt,
    createdAt: new Date().toISOString(),
    model: option(args, '--model') || null,
    reasoningEffort: option(args, '--reasoning') || null,
    browserProfileDirectory: cfg.profileDirectory
  });
  await launch(jobDir, cfg);

  if (has(args, '--async')) {
    console.log(JSON.stringify({ status: 'submitted', jobId, jobDir, response: path.join(jobDir, 'response.md') }, null, 2));
    process.exit(0);
  }
  const timeout = Number.parseInt(option(args, '--timeout-seconds') || '3600', 10);
  process.exit(await wait(jobDir, Number.isFinite(timeout) && timeout > 0 ? timeout : 3600));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
