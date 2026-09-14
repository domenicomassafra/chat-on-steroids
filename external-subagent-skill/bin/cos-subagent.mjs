#!/usr/bin/env node
import { promises as fs, constants as fsConstants, watch as watchFs, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(scriptDir);
const profilePath = path.join(skillDir, 'config', 'profile.json');
const scriptPath = fileURLToPath(import.meta.url);
const execFile = promisify(execFileCallback);
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const CHILD_ENV_KEYS = new Set([
  'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
]);

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  cos-subagent run <prompt.md> [--async] [--model <slug>] [--reasoning <level>] [--connector <name>] [--job-root <dir>] [--timeout-seconds <n>]
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
async function profile(configPath = profilePath) {
  const value = await readJson(configPath);
  const transport = value.transport;
  if (!['oracle-browser', 'legacy-electron'].includes(transport)) {
    throw new Error(`Chat On Steroids subagent transport must be explicitly set to oracle-browser or legacy-electron; received: ${JSON.stringify(transport)}`);
  }
  const failClosed = value.failClosed !== false;
  if (failClosed && transport === 'oracle-browser') {
    const required = ['targetHost', 'browserUserDataDir', 'profileDirectory', 'browserAccountFingerprint', 'browserAttachRunning', 'browserAttachHost', 'browserAttachPort', 'oracleExecutable', 'oracleWorkingDir', 'oracleSourceCommit', 'oracleExecutableSha256', 'oracleHomeDir', 'oracleAccountId', 'oracleAccountRole', 'defaultConnector'];
    const missing = required.filter(key => !value[key]);
    if (missing.length) throw new Error(`Oracle-derived subagent profile is incomplete: ${missing.join(', ')}`);
    if (value.targetHost && os.hostname() !== value.targetHost) {
      throw new Error(`Chat On Steroids subagents is pinned to ${value.targetHost}; refusing host ${os.hostname()}`);
    }
    if (value.browserAttachRunning !== true) {
      throw new Error('Oracle-derived subagent profile must use attach-running for the owner-selected Chrome identity');
    }
    if (value.browserAttachHost !== '127.0.0.1') {
      throw new Error(`Oracle-derived attach endpoint must be loopback 127.0.0.1; received: ${JSON.stringify(value.browserAttachHost)}`);
    }
    if (!Number.isInteger(value.browserAttachPort) || value.browserAttachPort <= 0 || value.browserAttachPort > 65535) {
      throw new Error(`Oracle-derived attach port is invalid: ${JSON.stringify(value.browserAttachPort)}`);
    }
  }
  if (failClosed && transport === 'legacy-electron') {
    const required = ['appExecutable', 'legacyBrowserUserDataDir', 'legacyProfileDirectory'];
    const missing = required.filter(key => !value[key]);
    if (missing.length) throw new Error(`Chat On Steroids rollback profile is incomplete: ${missing.join(', ')}`);
  }
  return value;
}

function configuredPath(value) {
  const expanded = expandHome(value);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(skillDir, expanded));
}

function childEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (CHILD_ENV_KEYS.has(key) || key.startsWith('LC_'))) env[key] = value;
  }
  return { ...env, ...extra };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function accountFingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) throw new Error('Owner-selected Chrome account metadata is empty');
  return `afp-${sha256(normalized).slice(0, 24)}`;
}
function pinnedHex(value, bytes, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be a ${bytes * 2}-character lowercase hex value`);
  }
  return normalized;
}
function cleanConnector(value) {
  const connector = String(value || '').trim();
  if (!connector || /[\r\n]/.test(connector)) throw new Error('connectorName must be one non-empty line');
  return connector;
}
function browserThinkingTime(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['none', 'minimal', 'low', 'light'].includes(normalized)) return 'light';
  if (['medium', 'standard'].includes(normalized)) return 'standard';
  if (['high', 'extended'].includes(normalized)) return 'extended';
  if (['xhigh', 'extra-high'].includes(normalized)) return 'extra-high';
  if (['max', 'ultra', 'heavy'].includes(normalized)) return 'heavy';
  if (normalized === 'pro') return 'pro';
  throw new Error(`Unsupported browser reasoning level: ${value}`);
}
async function ensureOracleHome(cfg) {
  const oracleHome = configuredPath(cfg.oracleHomeDir);
  const profileRoot = configuredPath(cfg.browserUserDataDir);
  const nestedProfile = path.join(profileRoot, cfg.profileDirectory);
  await fs.mkdir(oracleHome, { recursive: true, mode: 0o700 });
  const profileRootStat = await fs.stat(profileRoot).catch(() => null);
  const nestedProfileStat = await fs.stat(nestedProfile).catch(() => null);
  if (!profileRootStat?.isDirectory() || !nestedProfileStat?.isDirectory()) {
    throw new Error('Authorized Chat On Steroids Chrome profile root/profile is missing; refusing to create or copy owner browser state');
  }
  const localState = await readJson(path.join(profileRoot, 'Local State')).catch(() => null);
  const lastUsed = typeof localState?.profile?.last_used === 'string' ? localState.profile.last_used : null;
  if (lastUsed !== cfg.profileDirectory) {
    throw new Error(`Authorized Chrome profile is not active: expected ${cfg.profileDirectory}, observed ${lastUsed || 'unknown'}`);
  }
  const identityLabel = localState?.profile?.info_cache?.[cfg.profileDirectory]?.name;
  const observedAccountFingerprint = accountFingerprint(identityLabel);
  if (observedAccountFingerprint !== cfg.browserAccountFingerprint) {
    throw new Error(`Authorized Chrome account fingerprint mismatch: expected ${cfg.browserAccountFingerprint}, observed ${observedAccountFingerprint}`);
  }
  const configPath = path.join(oracleHome, 'config.json');
  const current = await readJson(configPath).catch(() => ({}));
  const accountId = cfg.oracleAccountId;
  const existingAccount = current?.accountPool?.accounts?.[accountId];
  if (existingAccount) {
    const expectedRole = cfg.oracleAccountRole || 'subagent';
    const existingProfileRoot = existingAccount.profileDir
      ? path.resolve(expandHome(existingAccount.profileDir))
      : null;
    const identityMismatch =
      (existingAccount.profile && existingAccount.profile !== 'chat-on-steroids-subagent') ||
      (existingAccount.chromeProfile && existingAccount.chromeProfile !== cfg.profileDirectory) ||
      (existingProfileRoot && existingProfileRoot !== profileRoot) ||
      (existingAccount.role && existingAccount.role !== expectedRole) ||
      (Array.isArray(existingAccount.providers) &&
        (existingAccount.providers.length !== 1 || existingAccount.providers[0] !== 'chatgpt')) ||
      existingAccount.enabled === false;
    if (identityMismatch) {
      throw new Error('Oracle account config disagrees with the authorized Chat On Steroids profile');
    }
  }
  const account = {
    ...(existingAccount || {}),
    providers: ['chatgpt'],
    profile: 'chat-on-steroids-subagent',
    chromeProfile: cfg.profileDirectory,
    profileDir: profileRoot,
    capabilities: ['text'],
    role: cfg.oracleAccountRole || 'subagent',
    enabled: true
  };
  const next = {
    ...current,
    accountPool: {
      ...(current.accountPool || {}),
      defaults: { ...(current.accountPool?.defaults || {}), chatgpt: accountId },
      groups: {
        ...(current.accountPool?.groups || {}),
        text: Array.from(new Set([...(current.accountPool?.groups?.text || []), accountId]))
      },
      accounts: { ...(current.accountPool?.accounts || {}), [accountId]: account }
    }
  };
  await atomicJson(configPath, next);
  return { oracleHome, profileRoot, accountFingerprint: observedAccountFingerprint };
}
async function verifyOracleProvenance(cfg) {
  const executable = configuredPath(cfg.oracleExecutable);
  const workingDir = configuredPath(cfg.oracleWorkingDir);
  if (!(await exists(executable))) throw new Error(`Oracle-derived executable not found: ${executable}`);
  if (!(await exists(workingDir))) throw new Error(`Oracle-derived working directory not found: ${workingDir}`);
  const expectedCommit = pinnedHex(cfg.oracleSourceCommit, 20, 'oracleSourceCommit');
  const expectedDigest = pinnedHex(cfg.oracleExecutableSha256, 32, 'oracleExecutableSha256');
  const { stdout } = await execFile('git', ['-C', workingDir, 'rev-parse', 'HEAD'], {
    env: childEnvironment(),
    encoding: 'utf8'
  });
  const observedCommit = String(stdout || '').trim().toLowerCase();
  if (observedCommit !== expectedCommit) {
    throw new Error(`Oracle source commit mismatch: expected ${expectedCommit}, observed ${observedCommit || 'missing'}`);
  }
  const observedDigest = sha256(await fs.readFile(executable));
  if (observedDigest !== expectedDigest) {
    throw new Error(`Oracle executable digest mismatch: expected ${expectedDigest}, observed ${observedDigest}`);
  }
  return { executable, workingDir, sourceCommit: observedCommit, executableSha256: observedDigest };
}
async function waitForSpawnAdmission(child) {
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
async function waitForOracleTerminalOrExit({
  child,
  oracleHome,
  sessionSlug,
  responsePath,
  timeoutMs
}) {
  const sessionsDir = path.join(oracleHome, 'sessions');
  const sessionMetaPath = path.join(sessionsDir, sessionSlug, 'meta.json');
  await fs.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  return await new Promise((resolve, reject) => {
    let settled = false;
    let checking = false;
    let watcher = null;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(fallback);
      watcher?.close();
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) => finish({ source: 'process', code, signal, session: null });
    const checkSession = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        const session = await readJson(sessionMetaPath).catch(() => null);
        const status = session?.status;
        if (!['completed', 'partial', 'error', 'cancelled'].includes(status)) return;
        if (status === 'completed') {
          const response = await fs.readFile(responsePath, 'utf8').catch(() => '');
          if (!response.trim()) return;
        }
        // Session metadata is the durable Oracle completion record. If the CLI keeps an
        // accessory handle alive after that record is terminal, stop only this task-owned
        // child so the CoS file-backed completion fence can advance deterministically.
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
        finish({
          source: 'session',
          code: status === 'completed' ? 0 : 1,
          signal: status === 'completed' ? null : 'SESSION_TERMINAL',
          session
        });
      } catch (error) {
        fail(error);
      } finally {
        checking = false;
      }
    };
    child.once('error', onError);
    child.once('exit', onExit);
    const timeout = setTimeout(
      () => fail(new Error(`Oracle-derived browser worker did not reach a terminal session within ${Math.ceil(timeoutMs / 1000)}s`)),
      timeoutMs
    );
    const fallback = setInterval(() => { void checkSession(); }, 1000);
    try {
      watcher = watchFs(sessionsDir, { persistent: true }, () => { void checkSession(); });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    void checkSession();
  });
}
async function launch(jobDir, cfg, spawnImpl = spawn) {
  if (cfg.transport === 'oracle-browser') {
    await verifyOracleProvenance(cfg);
    const child = spawnImpl(process.execPath, [scriptPath, '_oracle-worker', jobDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnvironment()
    });
    await waitForSpawnAdmission(child);
    child.unref();
    return;
  }
  const executable = configuredPath(cfg.appExecutable);
  if (!(await exists(executable))) throw new Error(`Chat On Steroids executable not found: ${executable}`);
  const child = spawnImpl(executable, [`--cos-subagent-job=${jobDir}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnvironment({
      COS_BROWSER_USER_DATA_DIR: configuredPath(cfg.legacyBrowserUserDataDir),
      COS_BROWSER_PROFILE_DIRECTORY: cfg.legacyProfileDirectory
    })
  });
  await waitForSpawnAdmission(child);
  child.unref();
}
async function launchWithFailureFence(jobDir, cfg, launchImpl = launch) {
  try {
    await launchImpl(jobDir, cfg);
  } catch (error) {
    await atomicJson(path.join(jobDir, 'done.json'), {
      status: 'error',
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
async function oracleSessionReceipt(oracleHome, sessionSlug, expected, hostIdentity = {}) {
  const sessionDir = path.join(oracleHome, 'sessions', sessionSlug);
  const session = await readJson(path.join(sessionDir, 'meta.json'));
  const receipt = session?.browser?.config?.providerReceipt;
  const runtime = session?.browser?.runtime;
  const connectorSelection = runtime?.connectorSelection;
  const observed = {
    provider: receipt?.provider,
    adapter: receipt?.adapter,
    accountRole: receipt?.accountRole,
    accountFingerprint: hostIdentity.accountFingerprint,
    profileKey: receipt?.profileKey,
    chromeProfile: session?.browser?.config?.chromeProfile,
    connectorName: connectorSelection?.observedName,
    connectorSelection,
    conversationId: runtime?.frozenConversationId,
    chromeTargetId: runtime?.frozenConversationTargetId
  };
  const required = ['provider', 'adapter', 'accountRole', 'profileKey', 'chromeProfile', 'connectorName', 'conversationId', 'chromeTargetId'];
  if (expected.accountFingerprint) required.push('accountFingerprint');
  const missing = required.filter(key => !observed[key]);
  if (missing.length) throw new Error(`Oracle session identity receipt is incomplete: ${missing.join(', ')}`);
  if (
    connectorSelection?.requestedName !== expected.connectorName ||
    connectorSelection?.observedName !== expected.connectorName ||
    connectorSelection?.exact !== true ||
    connectorSelection?.unique !== true ||
    connectorSelection?.sameChipBeforeSend !== true ||
    connectorSelection?.trustedChoiceInput !== true
  ) {
    throw new Error('Oracle session connector evidence is not an exact DOM-observed pre-Send proof');
  }
  if (runtime?.conversationId !== runtime?.frozenConversationId) {
    throw new Error('Oracle session conversation receipt is not bound to the frozen post-submit conversation');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (observed[key] !== value) throw new Error(`Oracle session identity mismatch for ${key}: expected ${value}, observed ${observed[key]}`);
  }
  return {
    transport: 'oracle-browser',
    host: os.hostname(),
    requested: expected,
    observed,
    oracleSessionId: session.id || sessionSlug
  };
}
async function runOracleWorker(jobDir) {
  const cfg = await profile();
  if (cfg.transport !== 'oracle-browser') throw new Error('Internal Oracle worker invoked for a non-Oracle transport');
  if (cfg.targetHost && os.hostname() !== cfg.targetHost) {
    throw new Error(`Chat On Steroids Subagents is pinned to ${cfg.targetHost}; refusing host ${os.hostname()}`);
  }
  const provenance = await verifyOracleProvenance(cfg);
  const { executable, workingDir } = provenance;
  const { oracleHome, accountFingerprint: observedAccountFingerprint } = await ensureOracleHome(cfg);
  const meta = await readJson(path.join(jobDir, 'meta.json'));
  const promptPath = path.join(jobDir, 'prompt.md');
  const promptHandle = await fs.open(promptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let prompt;
  try {
    const stat = await promptHandle.stat();
    if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) throw new Error('Oracle worker prompt must be a regular file no larger than 2 MiB');
    prompt = await promptHandle.readFile();
  } finally {
    await promptHandle.close();
  }
  if (prompt.length > MAX_PROMPT_BYTES || sha256(prompt) !== meta.promptSha256) throw new Error('Oracle worker prompt integrity check failed');
  if (!prompt.toString('utf8').trim()) throw new Error('Oracle-derived browser worker requires a non-empty prompt');
  const connectorName = cleanConnector(meta.connectorName);
  const model = String(meta.model || cfg.defaultModel || 'gpt-5.6-sol').trim();
  const sessionSlug = `cos-worker-${String(meta.jobId).replace(/[^a-z0-9]/gi, '').slice(-10).toLowerCase()}`;
  const responsePath = path.join(jobDir, 'response.md');
  const stdoutPath = path.join(jobDir, 'oracle.stdout.log');
  const stderrPath = path.join(jobDir, 'oracle.stderr.log');
  const stdout = await fs.open(stdoutPath, 'w', 0o600);
  const stderr = await fs.open(stderrPath, 'w', 0o600);
  const oracleArgs = [
    executable,
    '--engine', 'browser',
    '--model', model,
    '--account', cfg.oracleAccountId,
    '--no-notify',
    '--browser-attach-running',
    '--remote-chrome', `${cfg.browserAttachHost}:${cfg.browserAttachPort}`,
    '--chatgpt-connector', connectorName,
    '--slug', sessionSlug,
    '--write-output', responsePath,
    '--browser-timeout', `${Math.max(60, Number(meta.timeoutSeconds) || 3600)}s`,
    '--prompt-file', promptPath,
    '--prompt-hash', meta.promptSha256
  ];
  const thinking = browserThinkingTime(meta.reasoningEffort);
  if (thinking) oracleArgs.splice(oracleArgs.length - 2, 0, '--browser-thinking-time', thinking);
  const child = spawn(process.execPath, oracleArgs, {
    cwd: workingDir,
    stdio: ['ignore', stdout.fd, stderr.fd],
    env: childEnvironment({ ORACLE_HOME_DIR: oracleHome })
  });
  await atomicJson(path.join(jobDir, 'dispatch.json'), {
    transport: 'oracle-browser',
    pid: child.pid,
    host: os.hostname(),
    connectorName,
    oracleSessionId: sessionSlug,
    oracleSourceCommit: provenance.sourceCommit,
    oracleExecutableSha256: provenance.executableSha256,
    dispatchedAt: new Date().toISOString()
  });
  const exit = await waitForOracleTerminalOrExit({
    child,
    oracleHome,
    sessionSlug,
    responsePath,
    timeoutMs: (Math.max(60, Number(meta.timeoutSeconds) || 3600) * 1000) + 30_000
  }).finally(async () => {
    await stdout.close().catch(() => undefined);
    await stderr.close().catch(() => undefined);
  });
  if (exit.code !== 0) {
    const sessionError = exit.session?.error?.message || exit.session?.errorMessage;
    throw new Error(
      sessionError
        ? `Oracle-derived browser worker failed: ${sessionError}`
        : `Oracle-derived browser worker exited ${exit.code ?? exit.signal ?? 'unknown'}; see oracle.stderr.log`
    );
  }
  const response = await fs.readFile(responsePath, 'utf8').catch(() => '');
  if (!response.trim()) throw new Error('Oracle-derived browser worker completed without a response');
  const expectedReceipt = {
    provider: 'chatgpt',
    adapter: 'chatgpt-browser',
    accountRole: cfg.oracleAccountRole,
    accountFingerprint: observedAccountFingerprint,
    chromeProfile: cfg.profileDirectory,
    connectorName
  };
  if (cfg.oracleProfileKey) expectedReceipt.profileKey = cfg.oracleProfileKey;
  const receipt = await oracleSessionReceipt(oracleHome, sessionSlug, expectedReceipt, {
    accountFingerprint: observedAccountFingerprint
  });
  await atomicJson(path.join(jobDir, 'done.json'), {
    status: 'done',
    completedAt: new Date().toISOString(),
    receipt
  });
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
  const donePath = path.join(jobDir, 'done.json');
  const finishIfDone = async () => {
    if (await exists(path.join(jobDir, 'done.json'))) {
      const done = await readJson(donePath);
      const response = await fs.readFile(path.join(jobDir, 'response.md'), 'utf8').catch(() => '');
      if (done.status === 'done') {
        process.stdout.write(response);
        if (response && !response.endsWith('\n')) process.stdout.write('\n');
        return { finished: true, code: 0 };
      }
      if (response) process.stdout.write(response.endsWith('\n') ? response : `${response}\n`);
      console.error(done.error || 'Chat On Steroids worker reported an error');
      return { finished: true, code: 1 };
    }
    return { finished: false, code: 0 };
  };

  const immediate = await finishIfDone();
  if (immediate.finished) return immediate.code;

  return await new Promise((resolve) => {
    let settled = false;
    let checking = false;
    let watcher = null;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(fallback);
      watcher?.close();
    };
    const settle = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        const result = await finishIfDone();
        if (result.finished) settle(result.code);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        settle(1);
      } finally {
        checking = false;
      }
    };
    const timeout = setTimeout(() => {
      console.error(`Timed out waiting for ${jobDir}`);
      settle(124);
    }, timeoutSeconds * 1000);
    // fs.watch is the fast path: a dependency caller sleeps until done.json changes the
    // directory. The coarse fallback only covers filesystems where watch events are lost.
    const fallback = setInterval(() => { void check(); }, 5000);
    try {
      watcher = watchFs(jobDir, { persistent: true }, (_event, filename) => {
        if (!filename || filename.toString() === 'done.json') void check();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    void check();
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  const [command, target, ...args] = process.argv.slice(2);
  if (!command || !target) usage();

  try {
    if (command === '_oracle-worker') {
      try {
        await runOracleWorker(path.resolve(target));
        process.exit(0);
      } catch (error) {
        await atomicJson(path.join(path.resolve(target), 'done.json'), {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
        throw error;
      }
    }
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
    const sourceHandle = await fs.open(sourcePrompt, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let promptBytes;
    try {
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) throw new Error(`Prompt is not a regular file: ${sourcePrompt}`);
      if (sourceStat.size > MAX_PROMPT_BYTES) throw new Error(`Prompt exceeds the 2 MiB limit: ${sourcePrompt}`);
      promptBytes = await sourceHandle.readFile();
    } finally {
      await sourceHandle.close();
    }
    if (promptBytes.length > MAX_PROMPT_BYTES) throw new Error(`Prompt exceeds the 2 MiB limit: ${sourcePrompt}`);
    const cfg = await profile();
    const configuredRoot = option(args, '--job-root') || path.join(os.homedir(), '.chatonsteroids', 'jobs');
    const root = path.resolve(expandHome(configuredRoot));
    const jobId = stamp();
    const jobDir = path.join(root, jobId);
    await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
    const copiedPrompt = path.join(jobDir, 'prompt.md');
    await fs.writeFile(copiedPrompt, promptBytes, { mode: 0o600, flag: 'wx' });
    const copiedHandle = await fs.open(copiedPrompt, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let copiedHash;
    try { copiedHash = sha256(await copiedHandle.readFile()); } finally { await copiedHandle.close(); }
    const promptSha256 = sha256(promptBytes);
    if (copiedHash !== promptSha256) throw new Error('Copied prompt integrity check failed');
    const timeoutSeconds = Number.parseInt(option(args, '--timeout-seconds') || '3600', 10);
    const connectorName = cleanConnector(option(args, '--connector') || cfg.defaultConnector);
    const sourcePromptDisplay = sourcePrompt.startsWith(os.homedir())
      ? `~${sourcePrompt.slice(os.homedir().length)}`
      : path.basename(sourcePrompt);
    await atomicJson(path.join(jobDir, 'meta.json'), {
      jobId,
      sourcePrompt: sourcePromptDisplay,
      createdAt: new Date().toISOString(),
      promptSha256,
      model: option(args, '--model') || null,
      reasoningEffort: option(args, '--reasoning') || null,
      connectorName,
      transport: cfg.transport,
      timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 3600,
      browserProfileDirectory: cfg.transport === 'legacy-electron'
        ? cfg.legacyProfileDirectory
        : cfg.profileDirectory,
      browserUserDataDir: cfg.transport === 'legacy-electron'
        ? (cfg.legacyBrowserUserDataDir ? configuredPath(cfg.legacyBrowserUserDataDir) : undefined)
        : (cfg.browserUserDataDir ? configuredPath(cfg.browserUserDataDir) : undefined)
    });
    await launchWithFailureFence(jobDir, cfg);

    if (has(args, '--async')) {
      console.log(JSON.stringify({
        status: 'submitted',
        jobId,
        jobDir,
        response: path.join(jobDir, 'response.md'),
        join: `node ${JSON.stringify(fileURLToPath(import.meta.url))} join ${JSON.stringify(jobDir)}`
      }, null, 2));
      process.exit(0);
    }
    process.exit(await wait(jobDir, Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 3600));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {
  CHILD_ENV_KEYS,
  MAX_PROMPT_BYTES,
  profile,
  configuredPath,
  childEnvironment,
  accountFingerprint,
  cleanConnector,
  browserThinkingTime,
  oracleSessionReceipt,
  verifyOracleProvenance,
  waitForSpawnAdmission,
  waitForOracleTerminalOrExit,
  launchWithFailureFence,
  ensureOracleHome,
  runOracleWorker,
  status,
  wait,
  launch
};
