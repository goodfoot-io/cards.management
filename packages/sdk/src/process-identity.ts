/**
 * Process identity: who a PID is, whether it still exists, and which process
 * domain this process lives in.
 *
 * A start identity changes when a PID is reused, so it is compared before a PID
 * is trusted or signalled: Linux `bootId:starttime` from `/proc`, macOS the
 * `ps` `lstart` string, Windows `Win32_Process.CreationDate` ticks. A process
 * domain is the set of processes whose PIDs this process can see and signal —
 * one kernel boot and, on Linux, one PID namespace — and decides whether a PID
 * recorded elsewhere can be judged here at all.
 *
 * The wrapper's session observations, leadership check and bounded OS helper
 * live here too, so the server and the configuration share one
 * implementation. Every probe is bounded, and an unreadable observation is
 * `unknown`, never absence.
 *
 * @summary Process start identities, liveness probes, and process domains shared by the server and slot locks
 * @module
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';

/**
 * Opaque name for one POSIX session, compared only for equality.
 *
 * Never parsed, never arithmetic, and never passed to a signal. A token alone
 * cannot establish attribution; stable process start identities must be checked
 * independently. Windows uses a process-observation label rather than a session.
 */
export type SessionToken = string;

/** One process visible in an OS observation, including observable zombies. */
export interface WrapperProcessIdentity {
  readonly pid: number;
  /**
   * Start-identity token that changes when a PID is reused. Compared before any
   * signal, so a recycled PID fails the check rather than being signalled.
   */
  readonly startIdentity: string;
  readonly sessionToken: SessionToken;
  readonly processGroupId: number;
  /**
   * Current observed parent. Reparenting may erase ancestry or move a process
   * outside later observations; this field does not establish native adoption.
   */
  readonly parentPid: number;
  /** Kernel state; zombies remain visible until their owner reaps them. */
  readonly state?: string;
  /**
   * Numeric session id, where the OS exposes one. Read-only evidence used to
   * prove `sid === pid` leadership on Linux; macOS cannot supply it, and it is
   * never negated into a signal target on any platform.
   */
  readonly sessionLeaderPid?: number;
}

/** OS boundary for reading process session identity. */
export interface SessionPlatform {
  /**
   * Reads one process's identity.
   *
   * @param pid - Process to read.
   * @returns Its identity, `null` only for confirmed absence, or `unknown` on an unreadable probe.
   */
  identify(pid: number, timeoutMs?: number): Promise<WrapperProcessIdentity | null | 'unknown'>;
  /**
   * Reads a bounded OS process roster.
   *
   * @returns Every readable identity, or `'unknown'` when enumeration failed.
   */
  enumerate(timeoutMs?: number): Promise<readonly WrapperProcessIdentity[] | 'unknown'>;
}

/** Outcome of verifying a launch anchor and the applicable POSIX leadership checks. */
export type SessionLeadership =
  | { readonly status: 'verified'; readonly identity: WrapperProcessIdentity }
  | { readonly status: 'refused'; readonly stage: 'identify' | 'verify-session'; readonly reason: string };

/**
 * The live set of PIDs that are wrapper machinery rather than action work.
 *
 * Cleanup excludes these processes and their observed descendants from action
 * attribution. Production registrations last until the direct helper exits;
 * an injected helper with uncertain completion may remain excluded longer.
 */
export interface ControlHelperRegistry {
  /** The wrapper PID plus helpers still running or awaiting confirmed completion. */
  readonly pids: readonly number[];
  register(pid: number): void;
  release(pid: number): void;
  has(pid: number): boolean;
}

function isSafeProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 1;
}

/**
 * Creates the registry of identities cleanup must never signal.
 *
 * @param wrapperPid - The wrapper's own PID, permanently excluded.
 * @returns A registry seeded with the wrapper itself.
 */
export function createControlHelperRegistry(wrapperPid: number): ControlHelperRegistry {
  const helpers = new Set<number>();
  return {
    get pids() {
      return [wrapperPid, ...helpers];
    },
    register(pid) {
      if (isSafeProcessId(pid)) helpers.add(pid);
    },
    release(pid) {
      helpers.delete(pid);
    },
    has(pid) {
      return pid === wrapperPid || helpers.has(pid);
    }
  };
}

/**
 * The one `execFile` shape the session platform uses, narrowed to a seam.
 *
 * Narrow rather than `typeof execFile` so a test can supply a helper that never
 * calls back. A wedged `ps` is the failure this boundary exists to survive, and
 * it cannot be reproduced through a signature that only the real binding fits.
 */
export type SessionExecFile = (
  command: string,
  args: readonly string[],
  options: {
    readonly maxBuffer: number;
    readonly timeout: number;
    readonly killSignal: NodeJS.Signals;
    readonly env: NodeJS.ProcessEnv;
  },
  callback: (error: Error | null, stdout: string, stderr?: string) => void
) => { readonly pid?: number; kill(signal?: NodeJS.Signals): boolean } | undefined;

/** Default elapsed-time ceiling for one process-identity helper attempt. */
export const DEFAULT_SESSION_PROBE_TIMEOUT_MS = 2_000;

export interface NodeSessionPlatformOptions {
  /** Wrapper machinery excluded from action ownership while a probe is running. */
  readonly helpers?: ControlHelperRegistry;
  /** Ceiling on one helper invocation; defaults to {@link DEFAULT_SESSION_PROBE_TIMEOUT_MS}. */
  readonly probeTimeoutMs?: number;
  /** Process-exec boundary, injected so a wedged helper can be exercised. */
  readonly execFile?: SessionExecFile;
  /** Operating system whose reading rules apply; defaults to the host's. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Runs one identity helper under a ceiling it cannot talk its way past.
 *
 * The supplied exec boundary receives its own timeout and a literal SIGKILL
 * request. A separate timer settles this wait even if that boundary never calls
 * back. A timed-out helper remains protected: requesting a kill proves no exit.
 * A successful completion callback can release the injected registration;
 * an error or missing callback keeps conservative protection.
 *
 * @param exec - The exec boundary to run the helper through.
 * @param command - Helper to run.
 * @param args - Helper arguments.
 * @param timeoutMs - Ceiling on the whole invocation.
 * @returns Its output, or a failure when it did not answer in time.
 * @param helpers - Registry excluding transient probe processes from action ownership.
 */
export async function runIdentityProbe(
  exec: SessionExecFile,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  helpers?: ControlHelperRegistry
): Promise<IdentityProbeOutput> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { stdout: '', failed: true };
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<SessionExecFile>;
    const finish = (value: Omit<IdentityProbeOutput, 'helperPid'>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ...value, ...(child?.pid === undefined ? {} : { helperPid: child.pid }) });
    };
    try {
      child = exec(
        command,
        args,
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
        },
        (error, stdout, stderr) => {
          // Also handles synchronous test/custom exec callbacks: the child must
          // be registered before its completion releases that registration.
          queueMicrotask(() => {
            if (error === null && child?.pid !== undefined) helpers?.release(child.pid);
            const code = (error as { code?: unknown } | null)?.code;
            finish({
              stdout: String(stdout),
              failed: error !== null,
              ...(stderr === undefined ? {} : { stderr: String(stderr) }),
              ...(error === null ? { exitCode: 0 } : typeof code === 'number' ? { exitCode: code } : {})
            });
          });
        }
      );
      if (child?.pid !== undefined) helpers?.register(child.pid);
      timer = setTimeout(
        () => {
          try {
            child?.kill('SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              process.stderr.write(`[wrapper] could not kill wedged ${command}: ${String(error)}\n`);
          }
          finish({ stdout: '', failed: true });
        },
        Math.max(0, timeoutMs)
      );
      // This is the only live handle in an injected stalled probe. Keep the
      // deadline referenced so the caller actually receives its unknown result.
    } catch {
      finish({ stdout: '', failed: true });
    }
  });
}

/** One identity helper's output and how it ended. */
export interface IdentityProbeOutput {
  readonly stdout: string;
  /** True unless the helper exited 0 with complete output. */
  readonly failed: boolean;
  /** Present when the helper's stderr was observed. */
  readonly stderr?: string;
  /** Present when the helper exited by itself with a known code. */
  readonly exitCode?: number;
  readonly helperPid?: number;
}

/**
 * Runs a production probe directly through the helper's real Node lifetime.
 * Injected exec boundaries retain the narrower callback seam used by tests.
 * @param command - Literal OS helper executable.
 * @param args - Literal argument vector.
 * @param timeoutMs - Separate elapsed-time ceiling for this helper.
 * @param options - Protected helper registry and optional injected exec boundary.
 * @returns Output evidence or a failed observation, with the helper PID when known.
 */
export async function runNodeIdentityProbe(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  options: Pick<NodeSessionPlatformOptions, 'execFile' | 'helpers'> = {}
): Promise<IdentityProbeOutput> {
  if (options.execFile !== undefined)
    return runIdentityProbe(options.execFile, command, args, timeoutMs, options.helpers);
  try {
    const result = await runBoundedCommand(command, args, {
      timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
      helpers: options.helpers
    });
    const exited = !result.timedOut && result.outputComplete && result.exitCode !== null;
    return {
      stdout: result.stdout,
      failed: result.exitCode !== 0 || result.timedOut || !result.outputComplete,
      ...(exited ? { stderr: result.stderr, exitCode: result.exitCode as number } : {}),
      ...(result.pid === undefined ? {} : { helperPid: result.pid })
    };
  } catch {
    return { stdout: '', failed: true };
  }
}

/**
 * Bounds a whole read-only observation, including an uncooperative supplied seam.
 * The underlying read may complete later; its result cannot authorize late effects.
 * @param read - Read-only work whose rejection also means an unreadable observation.
 * @param timeoutMs - Whole elapsed-time ceiling.
 * @param unknown - Conservative result for timeout or rejection.
 * @returns The completed observation or its conservative replacement.
 */
export async function withinObservationDeadline<T>(read: () => Promise<T>, timeoutMs: number, unknown: T): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return unknown;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(unknown), timeoutMs);
  });
  try {
    return await Promise.race([read().catch(() => unknown), deadline]);
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}

function parseLinuxStat(pid: number, stat: string, bootId: string): WrapperProcessIdentity | null {
  // Slice past the comm field: it is parenthesised and may itself contain spaces.
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const session = Number(fields[3]);
  const startTime = fields[19];
  if (
    !/^\d+$/.test(startTime ?? '') ||
    !/^[A-Za-z]$/.test(fields[0] ?? '') ||
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(processGroupId) ||
    !Number.isSafeInteger(session)
  )
    return null;
  return {
    pid,
    parentPid,
    state: fields[0],
    startIdentity: `${bootId}:${startTime}`,
    sessionToken: `linux:${bootId}:${session}`,
    processGroupId,
    sessionLeaderPid: session
  };
}

function parseDarwinRow(row: string): WrapperProcessIdentity | null {
  // `lstart` is last because it is the one field containing spaces.
  const fields = row.trim().split(/\s+/);
  if (fields.length < 10) return null;
  const pid = Number(fields[0]);
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const session = fields[3];
  const state = fields[4];
  const started = fields.slice(5).join(' ');
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(processGroupId) ||
    session === undefined ||
    started === ''
  )
    return null;
  return { pid, parentPid, state, startIdentity: started, sessionToken: `darwin:${session}`, processGroupId };
}

const DARWIN_FORMAT = 'pid=,ppid=,pgid=,sess=,stat=,lstart=';

/**
 * Whether a failed macOS `ps -p` proves the PID absent [F9].
 *
 * Apple's `ps` exits 1 with empty stdout for a missing PID, but also on its
 * `errx(1, ...)` and `usage()` paths, so the output alone proves nothing. Only
 * exit 1 with empty stdout and empty stderr, confirmed by a fresh signal-0
 * probe made after `ps` returned, is absence; everything else stays unknown.
 * @param result - How `ps` ended.
 * @param result.stdout - Rows `ps` printed.
 * @param result.stderr - Diagnostics `ps` printed; undefined when not observed.
 * @param result.exitCode - Exit code; undefined or null when `ps` did not exit by itself.
 * @param absentNow - Fresh signal-0 probe; true on `ESRCH`.
 * @returns True only when absence is confirmed.
 */
function darwinPsConfirmsAbsence(
  result: { readonly stdout: string; readonly stderr?: string; readonly exitCode?: number | null },
  absentNow: () => boolean
): boolean {
  if (result.exitCode !== 1 || result.stdout.trim() !== '' || result.stderr === undefined) return false;
  if (result.stderr.trim() !== '') return false;
  return absentNow();
}

/**
 * Signal-0 probe through `process.kill`, failing closed.
 * @param pid - Process to probe.
 * @returns True only when the kernel answers `ESRCH`.
 */
function killReportsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Distinguishes confirmed process disappearance from an unreadable probe.
 * @param error - Failure returned by the process filesystem.
 * @returns Whether the kernel reported a missing process rather than a read failure.
 */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ESRCH';
}

/**
 * Creates the production session platform for the current operating system.
 *
 * Windows uses a bounded CIM process roster with real creation-time identities;
 * its opaque tokens describe observations, never Job Object custody.
 *
 * Both public operations have one elapsed-time ceiling covering their boot
 * read, directory scan, and process reads. OS helpers have an additional direct
 * command budget and retain registry protection until their real exit.
 *
 * @param options - Probe ceiling, exec boundary, and platform overrides.
 * @returns Identity and enumeration bound to this OS.
 */
export function createNodeSessionPlatform(options: NodeSessionPlatformOptions = {}): SessionPlatform {
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_SESSION_PROBE_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const linuxBootId = async (budget: number): Promise<string | null> => {
    try {
      return (
        await readFile('/proc/sys/kernel/random/boot_id', {
          encoding: 'utf8',
          signal: AbortSignal.timeout(Math.max(1, Math.ceil(budget)))
        })
      ).trim();
    } catch {
      return null;
    }
  };
  const windowsRoster = async (
    pid: number | undefined,
    budget: number
  ): Promise<readonly WrapperProcessIdentity[] | 'unknown'> => {
    const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process ${pid === undefined ? '' : `-Filter "ProcessId=${pid}"`} -ErrorAction Stop | Where-Object { $_.ProcessId -gt 1 } | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startIdentity=$_.CreationDate.ToUniversalTime().Ticks.ToString() } } | ConvertTo-Json -Compress`;
    const result = await runNodeIdentityProbe(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      budget,
      options
    );
    if (result.failed) return 'unknown';
    try {
      const parsed: unknown = result.stdout.trim() === '' ? [] : JSON.parse(result.stdout);
      const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const identities: WrapperProcessIdentity[] = [];
      for (const raw of rows) {
        if (raw === null || typeof raw !== 'object') return 'unknown';
        const row = raw as Record<string, unknown>;
        if (row['pid'] === 0 || row['pid'] === 1) continue;
        if (
          typeof row['pid'] !== 'number' ||
          !isSafeProcessId(row['pid']) ||
          typeof row['parentPid'] !== 'number' ||
          !Number.isSafeInteger(row['parentPid']) ||
          row['parentPid'] < 0 ||
          typeof row['startIdentity'] !== 'string' ||
          !/^[1-9]\d*$/.test(row['startIdentity'])
        )
          return 'unknown';
        identities.push({
          pid: row['pid'],
          parentPid: row['parentPid'],
          startIdentity: row['startIdentity'],
          processGroupId: 0,
          sessionToken: 'windows:process-observation'
        });
      }
      return identities.filter((member) => member.pid !== result.helperPid);
    } catch {
      return 'unknown';
    }
  };
  const identify = async (pid: number, budget: number): Promise<WrapperProcessIdentity | null | 'unknown'> => {
    if (!isSafeProcessId(pid)) return null;
    if (platform === 'win32') {
      const live = await windowsRoster(pid, budget);
      return live === 'unknown' ? 'unknown' : (live.find((member) => member.pid === pid) ?? null);
    }
    if (platform === 'linux') {
      const bootId = await linuxBootId(budget);
      if (bootId === null) return 'unknown';
      try {
        return (
          parseLinuxStat(
            pid,
            await readFile(`/proc/${pid}/stat`, {
              encoding: 'utf8',
              signal: AbortSignal.timeout(Math.max(1, Math.ceil(budget)))
            }),
            bootId
          ) ?? 'unknown'
        );
      } catch (error) {
        return isAbsent(error) ? null : 'unknown';
      }
    }
    const result = await runNodeIdentityProbe('ps', ['-o', DARWIN_FORMAT, '-p', String(pid)], budget, options);
    if (result.failed) return darwinPsConfirmsAbsence(result, () => killReportsAbsent(pid)) ? null : 'unknown';
    const row = result.stdout.split('\n').find((line) => line.trim() !== '');
    return row === undefined ? null : (parseDarwinRow(row) ?? 'unknown');
  };
  const enumerate = async (budget: number): Promise<readonly WrapperProcessIdentity[] | 'unknown'> => {
    if (platform === 'win32') return windowsRoster(undefined, budget);
    if (platform === 'linux') {
      const bootId = await linuxBootId(budget);
      if (bootId === null) return 'unknown';
      let names: string[];
      try {
        names = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
      } catch {
        return 'unknown';
      }
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(budget)));
      const identities = await Promise.all(
        names.map(async (name) => {
          try {
            return (
              parseLinuxStat(
                Number(name),
                await readFile(`/proc/${name}/stat`, { encoding: 'utf8', signal }),
                bootId
              ) ?? 'unknown'
            );
          } catch (error) {
            // Permission, I/O and malformed reads are not evidence of death.
            return isAbsent(error) ? null : 'unknown';
          }
        })
      );
      if (identities.includes('unknown')) return 'unknown';
      return identities.filter((entry): entry is WrapperProcessIdentity => entry !== null && entry !== 'unknown');
    }
    const result = await runNodeIdentityProbe('ps', ['-Ao', DARWIN_FORMAT], budget, options);
    if (result.failed) return 'unknown';
    const rows = result.stdout.split('\n').filter((line) => line.trim() !== '');
    const identities = rows.map(parseDarwinRow);
    if (identities.length === 0 || identities.some((entry) => entry === null)) return 'unknown';
    // ps appears in its own roster even though it has exited by the callback.
    return identities.filter(
      (entry): entry is WrapperProcessIdentity => entry !== null && entry.pid !== result.helperPid
    );
  };
  return {
    identify(pid, requestedTimeoutMs) {
      const budget = Math.max(1, Math.min(timeoutMs, requestedTimeoutMs ?? timeoutMs));
      return withinObservationDeadline(() => identify(pid, budget), budget, 'unknown');
    },
    enumerate(requestedTimeoutMs) {
      const budget = Math.max(1, Math.min(timeoutMs, requestedTimeoutMs ?? timeoutMs));
      return withinObservationDeadline(() => enumerate(budget), budget, 'unknown');
    }
  };
}

/**
 * Verifies the wrapper launch anchor before any action work starts.
 *
 * Both launch modes already give the wrapper that session — background launch
 * spawns it `detached`, and interactive launch makes it the terminal's own PTY
 * shell — so one check covers both rather than each mode asserting something
 * different. Windows verifies the real wrapper process identity without inventing a session or Job boundary.
 *
 * Fails closed: an unreadable identity or a failed enumeration refuses the
 * launch rather than proceeding with an unproven boundary.
 *
 * @param platform - Session boundary to read identities through.
 * @param options - The wrapper's own PID and the operating system to verify for.
 * @param options.pid - The wrapper's PID.
 * @param options.os - Operating system whose leadership rule applies.
 * @returns The verified wrapper identity, or a refusal naming what failed.
 * @param options.helpers - Wrapper probe processes excluded from the action boundary.
 */
export async function verifySessionLeadership(
  platform: SessionPlatform,
  options: { readonly pid: number; readonly os: NodeJS.Platform; readonly helpers?: ControlHelperRegistry }
): Promise<SessionLeadership> {
  if (!isSafeProcessId(options.pid))
    return { status: 'refused', stage: 'identify', reason: `Unsafe wrapper process id ${options.pid}` };
  const self = await withinObservationDeadline(
    () => platform.identify(options.pid, DEFAULT_SESSION_PROBE_TIMEOUT_MS),
    DEFAULT_SESSION_PROBE_TIMEOUT_MS,
    'unknown'
  );
  if (self === null || self === 'unknown')
    return { status: 'refused', stage: 'identify', reason: 'Wrapper could not read its own process identity' };
  if (options.os === 'win32') return { status: 'verified', identity: self };
  if (options.os === 'linux' && self.sessionLeaderPid !== options.pid)
    return {
      status: 'refused',
      stage: 'verify-session',
      reason: `Wrapper ${options.pid} does not lead its session (leader ${String(self.sessionLeaderPid)})`
    };
  if (options.os !== 'linux' && self.processGroupId !== options.pid)
    return {
      status: 'refused',
      stage: 'verify-session',
      reason: `Wrapper ${options.pid} does not lead its process group (${self.processGroupId})`
    };
  const live = await withinObservationDeadline(
    () => platform.enumerate(DEFAULT_SESSION_PROBE_TIMEOUT_MS),
    DEFAULT_SESSION_PROBE_TIMEOUT_MS,
    'unknown'
  );
  if (live === 'unknown')
    return { status: 'refused', stage: 'verify-session', reason: 'Live process enumeration failed' };
  const intruder = live.find(
    (entry) => entry.pid !== options.pid && !options.helpers?.has(entry.pid) && entry.sessionToken === self.sessionToken
  );
  if (intruder !== undefined)
    return {
      status: 'refused',
      stage: 'verify-session',
      reason: `Wrapper session is not private; process ${intruder.pid} already shares it`
    };
  return { status: 'verified', identity: self };
}

// ============================================================================
// Bounded OS helpers
// ============================================================================

/** Every OS helper has a separate elapsed-time and output budget. */
export interface BoundedCommandOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly helpers?: ControlHelperRegistry;
}

/** Local command observation; success is never a process-tree certificate. */
export interface BoundedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputComplete: boolean;
  readonly pid?: number;
  readonly error?: string;
}

/**
 * Runs literal argv with separately bounded execution and local output collection.
 * @param file - OS executable, never a shell command.
 * @param args - Literal arguments.
 * @param options - Deadline, output limit, and protected helper registry.
 * @returns The completed bounded attempt and its observation.
 * @throws When arguments or budgets are invalid.
 */
export async function runBoundedCommand(
  file: string,
  args: readonly string[],
  options: BoundedCommandOptions
): Promise<BoundedCommandResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError('OS-command timeout must be positive and finite');
  if ([file, ...args].some((value) => value.includes('\0'))) throw new Error('OS-command argv must not contain NUL');
  const maximum = options.maxOutputBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError('OS-command output budget must be positive');
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let child: ChildProcess | undefined;
    let exitCode: number | null = null;
    let exited = false;
    let settled = false;
    const finish = (timedOut: boolean, outputComplete: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        try {
          child?.kill('SIGKILL');
        } catch {
          /* The bounded attempt still ends. */
        }
      }
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      if (child?.pid !== undefined && exited) options.helpers?.release(child.pid);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        timedOut,
        outputComplete,
        ...(child?.pid === undefined ? {} : { pid: child.pid }),
        ...(error === undefined ? {} : { error })
      });
    };
    const timer = setTimeout(() => finish(true, false, 'OS-command deadline expired'), options.timeoutMs);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
      delete env['NODE_CHANNEL_FD'];
      delete env['NODE_CHANNEL_SERIALIZATION_MODE'];
      child = spawn(file, [...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid !== undefined) options.helpers?.register(child.pid);
      for (const [stream, destination] of [
        [child.stdout, stdout],
        [child.stderr, stderr]
      ] as const)
        stream?.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maximum) finish(false, false, 'OS-command output budget exceeded');
          else destination.push(chunk);
        });
      child.once('error', (error) =>
        finish(false, false, (error as NodeJS.ErrnoException).code ?? 'OS-command spawn failed')
      );
      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
        if (child?.pid !== undefined) options.helpers?.release(child.pid);
      });
      child.once('close', () => finish(false, true));
    } catch (error) {
      finish(false, false, (error as NodeJS.ErrnoException).code ?? 'OS-command spawn failed');
    }
  });
}

// ============================================================================
// Liveness, identity batches, and process domains
// ============================================================================

/** A probed process: the parts a lock records and compares. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  /** Changes when the PID is reused. */
  readonly startIdentity: string;
  /** POSIX process group; 0 on Windows, which has none. */
  readonly processGroupId: number;
}

/** One probe answer: an identity, `null` for confirmed absence, or `unknown` when unreadable. */
export type IdentityProbe = ProcessIdentity | null | 'unknown';

/** Linux process domain: one boot and one PID namespace. */
export interface LinuxProcessDomain {
  readonly platform: 'linux';
  /** `/etc/machine-id`; diagnostic only, never compared. */
  readonly machineId: string | null;
  /** `/proc/sys/kernel/random/boot_id`; null when unreadable. */
  readonly bootId: string | null;
  /** Inode of `/proc/self/ns/pid`; null when unreadable or `/proc` is not this namespace's. */
  readonly pidNamespace: string | null;
  /** Start time (field 22) of PID 1, the namespace's birth marker; null when unreadable. */
  readonly pidNamespaceInit: string | null;
}

/** macOS process domain: one boot. */
export interface DarwinProcessDomain {
  readonly platform: 'darwin';
  /** `IOPlatformUUID`; diagnostic only, never compared. */
  readonly machineId: string | null;
  /** `kern.bootsessionuuid`, which no clock step changes; null when unreadable. */
  readonly bootSessionUuid: string | null;
}

/** Windows process domain: no deciding part, so the PID rules always apply. */
export interface WindowsProcessDomain {
  readonly platform: 'win32';
  /** `MachineGuid`; diagnostic only, never compared. */
  readonly machineId: string | null;
  /** `LastBootUpTime`; display only, because clock steps move it. */
  readonly bootTime: string | null;
}

/** The set of processes whose PIDs this process can see and signal. */
export type ProcessDomain = LinuxProcessDomain | DarwinProcessDomain | WindowsProcessDomain;

/**
 * How a recorded holder's domain relates to this process's.
 *
 * - `same` — every deciding part matches: the PID rules decide, with identity comparison.
 * - `other` — a deciding part differs: the holder is from an earlier boot or container and dead at once.
 * - `pid_rules` — Windows, which has no deciding part: the PID rules decide.
 * - `unverified` — a deciding part is unreadable on either side and no non-null boot part differs:
 *   only PID absence decides, with no identity comparison.
 */
export type DomainComparison = 'same' | 'other' | 'pid_rules' | 'unverified';

/** Options of one batched identity read. */
export interface IdentifyManyOptions {
  /** Budget for the whole batch (one CIM call on Windows). */
  readonly timeoutMs: number;
  /** Also read this process's identity, and on Windows its domain, in the same call. */
  readonly includeSelf?: boolean;
}

/** Answers of one batched identity read. */
export interface IdentifyManyResult {
  /** One answer per requested PID. */
  readonly identities: ReadonlyMap<number, IdentityProbe>;
  /** This process's identity when `includeSelf` was set; `unknown` when it could not be read. */
  readonly self?: ProcessIdentity | 'unknown';
  /** This process's domain when `includeSelf` was set on Windows, read in the same call. */
  readonly domain?: WindowsProcessDomain;
}

/** OS reads behind the identity service; every one is injectable for tests. */
export interface ProcessIdentityReaders {
  /** Operating system whose rules apply. */
  readonly platform: NodeJS.Platform;
  /** This process's PID. */
  readonly pid: number;
  /** Signal-0 probe with `process.kill` semantics: throws `ESRCH`, `EPERM`, ... */
  readonly kill: (pid: number, signal: 0) => void;
  /** Reads a text file, rejecting with its errno. */
  readonly readText: (path: string, timeoutMs: number) => Promise<string>;
  /** Resolves a symbolic link, rejecting with its errno. */
  readonly readLink: (path: string) => Promise<string>;
  /** Reads the inode of a path, rejecting with its errno. */
  readonly inode: (path: string) => Promise<string>;
  /** Runs a literal OS helper under its own budget. */
  readonly runCommand: (
    file: string,
    args: readonly string[],
    options: { readonly timeoutMs: number }
  ) => Promise<BoundedCommandResult>;
}

/** Process identity operations bound to one set of OS readers. */
export interface ProcessIdentityService {
  /** Operating system whose rules this service applies. */
  readonly platform: NodeJS.Platform;
  /** This process's PID. */
  readonly pid: number;
  /**
   * Reads every visible process, in one CIM call on Windows.
   * @param timeoutMs - Budget for the whole roster.
   * @returns Every readable identity, or `unknown` when enumeration failed.
   */
  enumerate(timeoutMs: number): Promise<readonly ProcessIdentity[] | 'unknown'>;
  /**
   * Reads one process's identity.
   * @param pid - Process to read.
   * @param timeoutMs - Budget for this read.
   * @returns Its identity, `null` only for confirmed absence, or `unknown`.
   */
  identify(pid: number, timeoutMs?: number): Promise<IdentityProbe>;
  /**
   * Reads several identities, in one CIM call on Windows.
   * @param pids - Processes to read.
   * @param options - Budget and whether to include this process.
   * @returns One answer per PID, plus this process when requested.
   */
  identifyMany(pids: readonly number[], options: IdentifyManyOptions): Promise<IdentifyManyResult>;
  /**
   * Whether `kill(pid, 0)` reports the PID absent.
   * @param pid - Process to probe.
   * @returns True on `ESRCH`; false on success or `EPERM`.
   * @throws On any other errno.
   */
  isProcessAbsent(pid: number): boolean;
  /**
   * Whether a POSIX process group has a member, by signal 0 to `-pgid`.
   * @param pgid - Recorded group id; must be greater than 1.
   * @returns False on `ESRCH`, true on success or `EPERM`, null on Windows.
   * @throws On any other errno.
   */
  isProcessGroupAlive(pgid: number): boolean | null;
  /**
   * This process's domain, read once and cached.
   * @returns The domain; unreadable deciding parts are null.
   */
  currentProcessDomain(): Promise<ProcessDomain>;
  /**
   * This process's group id, read independently of {@link ProcessIdentityService.identify}.
   * @returns The group id, or null on Windows or when unreadable.
   */
  currentProcessGroupId(): Promise<number | null>;
  /**
   * This process's own identity, read once and cached when readable.
   * @returns The identity, or `unknown` when it could not be read.
   */
  currentProcessIdentity(): Promise<ProcessIdentity | 'unknown'>;
}

/** Budget of the Windows CIM read behind the domain and self identity when no batch supplied them. */
const WINDOWS_SELF_TIMEOUT_MS = 15_000;

/**
 * The host's OS readers.
 * @returns Readers over `process.kill`, the filesystem and {@link runBoundedCommand}.
 */
function hostReaders(): ProcessIdentityReaders {
  return {
    platform: process.platform,
    pid: process.pid,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    readText: (path, timeoutMs) =>
      readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) }),
    readLink: (path) => readlink(path),
    inode: async (path) => (await stat(path, { bigint: true })).ino.toString(),
    runCommand: (file, args, options) => runBoundedCommand(file, args, { timeoutMs: options.timeoutMs })
  };
}

/**
 * The `/proc/<pid>/stat` fields after the parenthesised command name.
 * @param text - Raw stat line.
 * @returns Fields from the state (field 3) onwards.
 */
function statFields(text: string): string[] {
  return text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
}

/**
 * Narrows a wrapper observation to the parts a lock records.
 * @param identity - Parsed wrapper identity.
 * @returns The identity without session details.
 */
function narrow(identity: WrapperProcessIdentity): ProcessIdentity {
  return {
    pid: identity.pid,
    parentPid: identity.parentPid,
    startIdentity: identity.startIdentity,
    processGroupId: identity.processGroupId
  };
}

/**
 * The errno code of a rejected read.
 * @param error - Rejection reason.
 * @returns Its `code`, if any.
 */
function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** One Windows CIM read: the matching processes, plus the domain parts when requested. */
interface WindowsCimResult {
  readonly processes: readonly ProcessIdentity[];
  readonly domain?: WindowsProcessDomain;
}

/**
 * The PowerShell script of one CIM roster read.
 * @param pids - Processes to read, or undefined for every process.
 * @param withDomain - Whether to read `MachineGuid` and `LastBootUpTime` in the same call.
 * @returns A script printing `{processes, machineId, bootTime}` as compact JSON.
 */
function windowsCimScript(pids: readonly number[] | undefined, withDomain: boolean): string {
  const filter = pids === undefined ? '' : ` -Filter "${pids.map((pid) => `ProcessId=${pid}`).join(' OR ')}"`;
  const domain = withDomain
    ? `$g = $null; try { $g = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { }; $b = $null; try { $b = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o') } catch { }; `
    : '$g = $null; $b = $null; ';
  return `$ErrorActionPreference = 'Stop'; $p = @(Get-CimInstance Win32_Process${filter} -ErrorAction Stop | Where-Object { $_.ProcessId -gt 1 } | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startIdentity=$_.CreationDate.ToUniversalTime().Ticks.ToString() } }); ${domain}[PSCustomObject]@{ processes=$p; machineId=$g; bootTime=$b } | ConvertTo-Json -Compress -Depth 4`;
}

/**
 * Parses one CIM roster read, failing closed on any malformed row.
 * @param stdout - The script's JSON output.
 * @param withDomain - Whether the domain parts were requested.
 * @returns The roster, or `unknown` when the output is not the expected shape.
 */
function parseWindowsCim(stdout: string, withDomain: boolean): WindowsCimResult | 'unknown' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return 'unknown';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  const record = parsed as Record<string, unknown>;
  const rows: unknown[] = Array.isArray(record['processes'])
    ? record['processes']
    : record['processes'] === null || record['processes'] === undefined
      ? []
      : [record['processes']];
  const processes: ProcessIdentity[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') return 'unknown';
    const row = raw as Record<string, unknown>;
    if (
      typeof row['pid'] !== 'number' ||
      !isSafeProcessId(row['pid']) ||
      typeof row['parentPid'] !== 'number' ||
      !Number.isSafeInteger(row['parentPid']) ||
      row['parentPid'] < 0 ||
      typeof row['startIdentity'] !== 'string' ||
      !/^[1-9]\d*$/.test(row['startIdentity'])
    )
      return 'unknown';
    processes.push({
      pid: row['pid'],
      parentPid: row['parentPid'],
      startIdentity: row['startIdentity'],
      processGroupId: 0
    });
  }
  if (!withDomain) return { processes };
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  return {
    processes,
    domain: { platform: 'win32', machineId: text(record['machineId']), bootTime: text(record['bootTime']) }
  };
}

/**
 * Creates the identity service over the given OS readers.
 * @param readers - Overrides for any OS read; defaults are the host's.
 * @returns Identity operations; domain, group and self reads are cached per service.
 */
export function createProcessIdentity(readers: Partial<ProcessIdentityReaders> = {}): ProcessIdentityService {
  const os: ProcessIdentityReaders = { ...hostReaders(), ...readers };
  const { platform, pid: selfPid } = os;
  let domainCache: Promise<ProcessDomain> | undefined;
  let groupCache: Promise<number | null> | undefined;
  let selfCache: ProcessIdentity | undefined;

  const absent = (pid: number): boolean => {
    try {
      os.kill(pid, 0);
      return false;
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ESRCH') return true;
      if (code === 'EPERM') return false;
      throw error;
    }
  };
  const absentFailClosed = (pid: number): boolean => {
    try {
      return absent(pid);
    } catch {
      return false;
    }
  };
  const readOptional = async (path: string, timeoutMs: number): Promise<string | null> => {
    try {
      const value = (await os.readText(path, timeoutMs)).trim();
      return value === '' ? null : value;
    } catch {
      return null;
    }
  };
  // /proc may belong to another PID namespace; only a /proc/self that names
  // this process speaks for it.
  const procIsOurs = async (): Promise<boolean> => {
    try {
      return (await os.readLink('/proc/self')) === String(selfPid);
    } catch {
      return false;
    }
  };

  const windowsCim = async (
    pids: readonly number[] | undefined,
    withDomain: boolean,
    timeoutMs: number
  ): Promise<WindowsCimResult | 'unknown'> => {
    const result = await os.runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', windowsCimScript(pids, withDomain)],
      { timeoutMs }
    );
    if (result.exitCode !== 0 || result.timedOut || !result.outputComplete) return 'unknown';
    const parsed = parseWindowsCim(result.stdout, withDomain);
    if (parsed === 'unknown') return parsed;
    // The PowerShell helper lists itself in a full roster.
    return result.pid === undefined
      ? parsed
      : { ...parsed, processes: parsed.processes.filter((entry) => entry.pid !== result.pid) };
  };

  const linuxIdentify = async (pid: number, timeoutMs: number): Promise<IdentityProbe> => {
    let bootId: string;
    try {
      bootId = (await os.readText('/proc/sys/kernel/random/boot_id', timeoutMs)).trim();
    } catch {
      return 'unknown';
    }
    if (bootId === '') return 'unknown';
    let text: string;
    try {
      text = await os.readText(`/proc/${pid}/stat`, timeoutMs);
    } catch (error) {
      return isAbsent(error) ? null : 'unknown';
    }
    const parsed = parseLinuxStat(pid, text, bootId);
    return parsed === null ? 'unknown' : narrow(parsed);
  };

  const darwinIdentify = async (pid: number, timeoutMs: number): Promise<IdentityProbe> => {
    const result = await os.runCommand('ps', ['-o', DARWIN_FORMAT, '-p', String(pid)], { timeoutMs });
    if (result.timedOut || !result.outputComplete || result.exitCode === null) return 'unknown';
    if (result.exitCode !== 0) return darwinPsConfirmsAbsence(result, () => absentFailClosed(pid)) ? null : 'unknown';
    const row = result.stdout.split('\n').find((line) => line.trim() !== '');
    const parsed = row === undefined ? null : parseDarwinRow(row);
    return parsed === null || parsed.pid !== pid ? 'unknown' : narrow(parsed);
  };

  const identifyMany = async (pids: readonly number[], options: IdentifyManyOptions): Promise<IdentifyManyResult> => {
    const unique = [...new Set(pids)];
    if (platform === 'win32') {
      const requested = options.includeSelf === true ? [...new Set([...unique, selfPid])] : unique;
      if (requested.length === 0) return { identities: new Map() };
      const valid = requested.filter(isSafeProcessId);
      const roster =
        valid.length === 0
          ? ({ processes: [] } satisfies WindowsCimResult)
          : await withinObservationDeadline<WindowsCimResult | 'unknown'>(
              () => windowsCim(valid, options.includeSelf === true, options.timeoutMs),
              options.timeoutMs,
              'unknown'
            );
      const identities = new Map<number, IdentityProbe>();
      for (const pid of unique) {
        if (!isSafeProcessId(pid)) identities.set(pid, null);
        else if (roster === 'unknown') identities.set(pid, 'unknown');
        else identities.set(pid, roster.processes.find((entry) => entry.pid === pid) ?? null);
      }
      if (options.includeSelf !== true) return { identities };
      if (roster === 'unknown') return { identities, self: 'unknown' };
      const self = roster.processes.find((entry) => entry.pid === selfPid);
      if (self !== undefined) selfCache = self;
      if (roster.domain !== undefined) domainCache ??= Promise.resolve(roster.domain);
      return {
        identities,
        self: self ?? 'unknown',
        ...(roster.domain === undefined ? {} : { domain: roster.domain })
      };
    }
    const answers = await Promise.all(unique.map((pid) => service.identify(pid, options.timeoutMs)));
    const identities = new Map(unique.map((pid, index) => [pid, answers[index] as IdentityProbe]));
    if (options.includeSelf !== true) return { identities };
    return { identities, self: await service.currentProcessIdentity() };
  };

  const readDomain = async (): Promise<ProcessDomain> => {
    const budget = DEFAULT_SESSION_PROBE_TIMEOUT_MS;
    if (platform === 'linux') {
      const [machineId, bootId, ours] = await Promise.all([
        readOptional('/etc/machine-id', budget),
        readOptional('/proc/sys/kernel/random/boot_id', budget),
        procIsOurs()
      ]);
      let pidNamespace: string | null = null;
      let pidNamespaceInit: string | null = null;
      if (ours) {
        try {
          pidNamespace = await os.inode('/proc/self/ns/pid');
        } catch {
          pidNamespace = null;
        }
        const init = await readOptional('/proc/1/stat', budget);
        const start = init === null ? undefined : statFields(init)[19];
        pidNamespaceInit = start !== undefined && /^\d+$/.test(start) ? start : null;
      }
      return { platform: 'linux', machineId, bootId, pidNamespace, pidNamespaceInit };
    }
    const sysctl = await os
      .runCommand('sysctl', ['-n', 'kern.bootsessionuuid'], { timeoutMs: budget })
      .catch(() => undefined);
    const bootSessionUuid =
      sysctl?.exitCode === 0 && sysctl.outputComplete && sysctl.stdout.trim() !== '' ? sysctl.stdout.trim() : null;
    const ioreg = await os
      .runCommand('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeoutMs: budget })
      .catch(() => undefined);
    const machineId =
      ioreg?.exitCode === 0 ? (/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioreg.stdout)?.[1] ?? null) : null;
    return { platform: 'darwin', machineId, bootSessionUuid };
  };

  const readGroup = async (): Promise<number | null> => {
    if (platform === 'win32') return null;
    if (platform === 'linux') {
      if (!(await procIsOurs())) return null;
      const text = await readOptional('/proc/self/stat', DEFAULT_SESSION_PROBE_TIMEOUT_MS);
      const group = text === null ? Number.NaN : Number(statFields(text)[2]);
      return Number.isSafeInteger(group) && group > 0 ? group : null;
    }
    const result = await os
      .runCommand('ps', ['-o', 'pgid=', '-p', String(selfPid)], { timeoutMs: DEFAULT_SESSION_PROBE_TIMEOUT_MS })
      .catch(() => undefined);
    const group = result?.exitCode === 0 ? Number(result.stdout.trim()) : Number.NaN;
    return Number.isSafeInteger(group) && group > 0 ? group : null;
  };

  const service: ProcessIdentityService = {
    platform,
    pid: selfPid,
    async enumerate(timeoutMs) {
      if (platform === 'win32') {
        const roster = await withinObservationDeadline<WindowsCimResult | 'unknown'>(
          () => windowsCim(undefined, false, timeoutMs),
          timeoutMs,
          'unknown'
        );
        return roster === 'unknown' ? roster : roster.processes;
      }
      if (platform === 'linux') {
        return withinObservationDeadline<readonly ProcessIdentity[] | 'unknown'>(
          async () => {
            let bootId: string;
            try {
              bootId = (await os.readText('/proc/sys/kernel/random/boot_id', timeoutMs)).trim();
            } catch {
              return 'unknown';
            }
            const names = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
            const rows = await Promise.all(
              names.map(async (name): Promise<ProcessIdentity | null | 'unknown'> => {
                try {
                  const parsed = parseLinuxStat(
                    Number(name),
                    await os.readText(`/proc/${name}/stat`, timeoutMs),
                    bootId
                  );
                  return parsed === null ? 'unknown' : narrow(parsed);
                } catch (error) {
                  // Permission, I/O and malformed reads are not evidence of death.
                  return isAbsent(error) ? null : 'unknown';
                }
              })
            );
            if (rows.includes('unknown')) return 'unknown';
            return rows.filter((row): row is ProcessIdentity => row !== null && row !== 'unknown');
          },
          timeoutMs,
          'unknown'
        );
      }
      return withinObservationDeadline<readonly ProcessIdentity[] | 'unknown'>(
        async () => {
          const result = await os.runCommand('ps', ['-Ao', DARWIN_FORMAT], { timeoutMs });
          if (result.exitCode !== 0 || result.timedOut || !result.outputComplete) return 'unknown';
          const rows = result.stdout
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map(parseDarwinRow);
          if (rows.length === 0 || rows.some((row) => row === null)) return 'unknown';
          // ps lists itself even though it has exited by now.
          return rows
            .filter((row): row is WrapperProcessIdentity => row !== null && row.pid !== result.pid)
            .map(narrow);
        },
        timeoutMs,
        'unknown'
      );
    },
    async identify(pid, timeoutMs = DEFAULT_SESSION_PROBE_TIMEOUT_MS) {
      if (!isSafeProcessId(pid)) return null;
      // A fresh ESRCH settles absence without a helper process.
      if (absentFailClosed(pid)) return null;
      if (platform === 'win32') {
        return (await identifyMany([pid], { timeoutMs })).identities.get(pid) ?? 'unknown';
      }
      const read = platform === 'linux' ? linuxIdentify : darwinIdentify;
      return withinObservationDeadline<IdentityProbe>(() => read(pid, timeoutMs), timeoutMs, 'unknown');
    },
    identifyMany,
    isProcessAbsent: absent,
    isProcessGroupAlive(pgid) {
      if (platform === 'win32') return null;
      if (!isSafeProcessId(pgid)) throw new RangeError(`Refusing to probe process group ${pgid}`);
      return !absent(-pgid);
    },
    currentProcessDomain() {
      if (platform === 'win32') {
        if (domainCache !== undefined) return domainCache;
        return identifyMany([], { timeoutMs: WINDOWS_SELF_TIMEOUT_MS, includeSelf: true }).then(
          (result) => result.domain ?? { platform: 'win32', machineId: null, bootTime: null }
        );
      }
      domainCache ??= readDomain();
      return domainCache;
    },
    currentProcessGroupId() {
      groupCache ??= readGroup();
      return groupCache;
    },
    async currentProcessIdentity() {
      if (selfCache !== undefined) return selfCache;
      let self: IdentityProbe;
      if (platform === 'win32') {
        const result = await identifyMany([], { timeoutMs: WINDOWS_SELF_TIMEOUT_MS, includeSelf: true });
        self = result.self ?? 'unknown';
      } else if (platform === 'linux' && !(await procIsOurs())) {
        self = 'unknown';
      } else {
        self = await service.identify(selfPid);
      }
      if (self === null || self === 'unknown') return 'unknown';
      selfCache = self;
      return self;
    }
  };
  return service;
}

/**
 * Compares a recorded holder's domain with this process's.
 * @param holder - Domain recorded in the lock.
 * @param self - This process's domain.
 * @returns How the holder's PIDs may be judged here.
 */
export function compareDomains(holder: ProcessDomain, self: ProcessDomain): DomainComparison {
  if (holder.platform !== self.platform) return 'other';
  if (holder.platform === 'win32' || self.platform === 'win32') return 'pid_rules';
  const parts: { boot: boolean; held: string | null; own: string | null }[] =
    holder.platform === 'linux' && self.platform === 'linux'
      ? [
          { boot: true, held: holder.bootId, own: self.bootId },
          { boot: false, held: holder.pidNamespace, own: self.pidNamespace },
          { boot: false, held: holder.pidNamespaceInit, own: self.pidNamespaceInit }
        ]
      : holder.platform === 'darwin' && self.platform === 'darwin'
        ? [{ boot: true, held: holder.bootSessionUuid, own: self.bootSessionUuid }]
        : [];
  const differs = (part: (typeof parts)[number]): boolean =>
    part.held !== null && part.own !== null && part.held !== part.own;
  if (parts.some((part) => part.held === null || part.own === null)) {
    // With a part unreadable, only a boot that provably differs is decisive.
    return parts.some((part) => part.boot && differs(part)) ? 'other' : 'unverified';
  }
  return parts.some(differs) ? 'other' : 'same';
}

let defaultService: ProcessIdentityService | undefined;

/**
 * The host's identity service, created on first use.
 * @returns The process-wide service over the real OS readers.
 */
export function processIdentity(): ProcessIdentityService {
  defaultService ??= createProcessIdentity();
  return defaultService;
}

/**
 * Reads one process's identity on the host.
 * @param pid - Process to read.
 * @param timeoutMs - Budget for this read.
 * @returns Its identity, `null` only for confirmed absence, or `unknown`.
 */
export function identify(pid: number, timeoutMs?: number): Promise<IdentityProbe> {
  return processIdentity().identify(pid, timeoutMs);
}

/**
 * Reads several identities on the host, in one CIM call on Windows.
 * @param pids - Processes to read.
 * @param options - Budget and whether to include this process.
 * @returns One answer per PID, plus this process when requested.
 */
export function identifyMany(pids: readonly number[], options: IdentifyManyOptions): Promise<IdentifyManyResult> {
  return processIdentity().identifyMany(pids, options);
}

/**
 * Whether `kill(pid, 0)` reports the PID absent on the host.
 * @param pid - Process to probe.
 * @returns True on `ESRCH`; false on success or `EPERM`.
 */
export function isProcessAbsent(pid: number): boolean {
  return processIdentity().isProcessAbsent(pid);
}

/**
 * Whether a POSIX process group has a member on the host.
 * @param pgid - Recorded group id; must be greater than 1.
 * @returns False on `ESRCH`, true on success or `EPERM`, null on Windows.
 */
export function isProcessGroupAlive(pgid: number): boolean | null {
  return processIdentity().isProcessGroupAlive(pgid);
}

/**
 * This process's domain on the host, read once and cached.
 * @returns The domain; unreadable deciding parts are null.
 */
export function currentProcessDomain(): Promise<ProcessDomain> {
  return processIdentity().currentProcessDomain();
}

/**
 * This process's group id on the host, read independently of {@link identify}.
 * @returns The group id, or null on Windows or when unreadable.
 */
export function currentProcessGroupId(): Promise<number | null> {
  return processIdentity().currentProcessGroupId();
}

/**
 * This process's own identity on the host.
 * @returns The identity, or `unknown` when it could not be read.
 */
export function currentProcessIdentity(): Promise<ProcessIdentity | 'unknown'> {
  return processIdentity().currentProcessIdentity();
}
