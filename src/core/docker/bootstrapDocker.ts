// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker CLI of the extension (no bypass of the worker, by construction), only for the bootstrap: whether the CLI
// is installed and the engine answers (`docker info`), whether either is Podman, the helper image (its check and build,
// and its maintenance, the rebuild and the cleanup, in the extension's preparation of the worker for an operation
// `open` and in the background prebuild), the start of the worker (`docker run -i`), the list of the Docker contexts,
// the test of a new remote host, and the attach diagnostics (what the Dev Containers extension sees through the local CLI). Every
// other Docker action runs in the worker, except "Remove Devspaces from This Docker Engine…", which ends the worker and
// removes what Devspaces keeps on the engine with `run` of this CLI (engineRemoval.ts; it adds no member here). A call
// of an operation on an SSH host goes through the Docker pipe of the extension for the host while a connection of the
// relay to it is open (BootstrapDockerOptions.dockerPipe), without an SSH login of its own, else with
// DOCKER_HOST=ssh://<host>; before that connection, a call that only reads runs on the shell before the relay (BootstrapDockerOptions.remoteShell, isShellCall), whose
// login the connection then takes over. The work of the view Docker Hosts runs all its calls on that shell, also those
// that change something and also on the VM of Devspaces (runWithDockerTarget with `onShell`, isSharedShellCall), so they
// share one login of the host. The work in the background on an SSH host never logs in itself
// (runWithDockerTarget with `withoutLogin`, dockerTargets.ts): without that connection, its call is refused. A call of
// an operation on the WSL distribution of Devspaces always goes through
// the Docker pipe of the extension for it (BootstrapDockerOptions.servePipe), which needs no connection of the relay; it
// never logs in with `ssh://`. The calls of an operation on a remote host run with the Docker CLI of Devspaces
// when it is installed (BootstrapDockerOptions.ownCli, one tested version), also on a computer without a Docker CLI of
// its own; the other calls with the Docker CLI of this computer. The build of the helper image runs in a container of
// the build image of Devspaces on the engine (buildx, BuildKit; buildxImage.ts, buildImage), the same on every engine:
// only the way to the engine differs. A call that does not only read is logged with its command (directCommandName), never its arguments. Output is read as JSON (`docker --version` as its one line), never
// as a table. No `vscode`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CommandError, errorMessage, UserFacingError } from '../errors';
import { Messages, dockerHostReason } from '../messages';
import { HELPER_DOCKER_SOCKET, LABEL_BUILD_ID } from '../names';
import { abortError, isAbortError, sleep, systemClock, type Clock, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { BUILD_CONTAINER_PREFIX, BUILDX_PIN, DOCKER_RUN_FAILED_EXIT_CODE, buildxImageTag, buildxPulledReference, buildxRunArgs } from './buildxImage';
import { contextTar } from './contextTar';
import { deleteEnv, dockerCommandWords, dockerProcessEnv, isReadOnlyDockerCall } from './dockerCli';
import { hostEndpoint, isVmHost, isSshClosedBeforeLogin, type DockerTarget } from './dockerHost';
import type { ImageInfo } from './dockerObjects';
import { DOCKER_INFO_TIMEOUT_MS, DOCKER_QUERY_TIMEOUT_MS } from './dockerTimeouts';
import { extractBaseImages } from '../imageCheck/dockerfile';
import { isVolumeReaderCall } from '../hosts/volumeReader';
import { operationDockerTarget, operationOnShell, operationOpenLoginOnly, operationWithoutLogin, outsideOperation } from './dockerTargets';
import { isRecord } from '../valueChecks';

/** Result of `docker info`. */
export interface DaemonStatus {
  running: boolean;
  /** Server version when running; otherwise the error of `docker info`, for the log. */
  detail: string;
}

/**
 * `docker --version` of the Podman CLI: "podman version 5.2.2". The package podman-docker installs a script `docker`
 * that runs podman, so its `docker --version` prints this too. The Docker CLI prints "Docker version 27.1.1, build …".
 */
const PODMAN_CLI_VERSION = /^\s*podman version\b/i;
/** The name of the engine in `docker version` when the Docker CLI talks to the Docker-compatible API of Podman. */
const PODMAN_ENGINE_COMPONENT = /\bpodman\b/i;

/**
 * A missing Docker CLI is looked up again at most this often (with `findDocker`), so that Docker Desktop installed or
 * updated while VS Code runs is found without a reload.
 */
export const DOCKER_CLI_LOOKUP_RETRY_MS = 10_000;

/**
 * The wait before the one repetition of a Docker call that only reads, after the SSH server of a remote Docker
 * host closed the connection before the login (see sshDroppedReadCall).
 */
export const SSH_DROP_RETRY_DELAY_MS = 1_000;

/**
 * True when a Docker call that only reads failed because the SSH server of the remote Docker host closed the
 * connection before the login (the Docker CLI's `ssh … docker system dial-stdio` exited with 255, and ssh said nothing
 * else, see isSshClosedBeforeLogin). The command never reached the engine then. The Docker CLI opens a new SSH connection
 * for each call (up to five for one failing call), and sshd drops new connections at random while more than 10 are not
 * logged in yet (MaxStartups 10:30:100), so a call is repeated once, after SSH_DROP_RETRY_DELAY_MS. A refusal of
 * PerSourcePenalties lasts longer; the repetition fails too, and the error says why (DockerHostProblem closedBeforeLogin).
 */
export function sshDroppedReadCall(args: readonly string[], result: RunResult): boolean {
  if (result.exitCode === 0 || result.timedOut || !isReadOnlyDockerCall(args)) return false;
  return /\bdial-stdio\b[^\n]*exit status 255/.test(result.stderr) && isSshClosedBeforeLogin(result.stderr);
}

/** Docker objects whose command is the second word (`docker image rm`, `docker context create`). */
const DOCKER_OBJECTS = new Set(['container', 'image', 'volume', 'network', 'context', 'system', 'builder', 'buildx', 'compose', 'plugin', 'manifest']);

/**
 * The command of a call for its log line (`build`, `pull`, `image rm`), never an argument (an image name, a path, or a
 * value).
 */
export function directCommandName(args: readonly string[]): string {
  const [command, subcommand] = dockerCommandWords(args);
  if (command === undefined) return '';
  return DOCKER_OBJECTS.has(command) && subcommand !== undefined && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
}

/** What `docker image inspect` and `docker image rm` say of an image that does not exist. */
const IMAGE_MISSING_PATTERN = /no such (image|object)/i;

/** Docker refuses to remove an image that a container or another image uses. */
export const IMAGE_IN_USE_PATTERN = /conflict|in use|being used|is using|dependent child images/i;

/** Parses output with one JSON value per line (`--format '{{json …}}'`). Empty and invalid lines are skipped. */
export function parseJsonLines(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      values.push(JSON.parse(text));
    } catch {
      // A warning or another line that is not JSON.
    }
  }
  return values;
}

/** Parses the output of `--format '{{json .X}}'` for a single object. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Options of `docker run` / `docker exec` whose `NAME=value` can hold a secret (for example a `${localEnv:…}` token). */
const ENV_FLAGS = new Set(['-e', '--env']);

function redactEnv(assignment: string): string {
  const index = assignment.indexOf('=');
  return index < 0 ? assignment : `${assignment.slice(0, index)}=***`;
}

/** Command for error messages, which end up in the log: values of environment variables are hidden. */
export function commandText(args: readonly string[]): string {
  const shown = args.map((arg, index) => {
    if (index > 0 && ENV_FLAGS.has(args[index - 1])) return redactEnv(arg);
    if (arg.startsWith('--env=')) return `--env=${redactEnv(arg.slice('--env='.length))}`;
    return arg;
  });
  const text = `docker ${shown.join(' ')}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function labelArgs(labels: Record<string, string> | undefined, flag: string): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(labels ?? {})) args.push(flag, `${key}=${value}`);
  return args;
}

/** Options of BootstrapDocker. */
export interface BootstrapDockerOptions {
  /**
   * Looks up the Docker CLI (for example `findDockerCli`). With it, the adapter looks again while the CLI is missing,
   * at most every DOCKER_CLI_LOOKUP_RETRY_MS, and after the CLI could not be started. Without it, the path stays fixed.
   */
  findDocker?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined;
  /** Default: the system clock. */
  clock?: Clock;
  /**
   * Called with the result of each `docker info` (daemonStatus), for the context key of the Docker setup. Docker is not
   * asked for it: only the checks that run anyway are reported.
   */
  onDaemonStatus?: (running: boolean) => void;
  /**
   * With `findDocker`: called when a CLI that was found before cannot be started anymore (ENOENT, for example Docker was
   * uninstalled or moved while VS Code runs), after the adapter forgot its path. The Docker setup shows the setup in the
   * sidebar then. The callback should not look the CLI up itself: that would count as the next lookup, and a CLI back
   * seconds later (for example after Docker Desktop updated itself) would be found only 10 seconds later.
   */
  onCliLost?: () => void;
  /**
   * With `findDocker`: called with the full path of a CLI that was missing and is found now (not for the path that the
   * constructor gets), after the adapter took it.
   */
  onCliFound?: (dockerPath: string) => void;
  /**
   * DOCKER_HOST for the calls of an operation on the remote engine `target`: the Docker pipe of the extension for its
   * host while a connection of the relay to it is open (HostPipes.dockerHost); undefined otherwise, and the call logs in
   * with `ssh://<host>`. Not for the start of the worker (`start`), whose standard input stays open.
   */
  dockerPipe?: (target: DockerTarget) => string | undefined;
  /**
   * Serves the Docker pipe of the extension for the remote engine `target` before a Docker call of an operation there,
   * when its calls always go through it (the WSL distribution of Devspaces, HostPipes.serve); resolves when the pipe
   * listens or could not, and never rejects. A call there without the pipe fails, except one that only reads, which
   * runs on the shell before the relay.
   */
  servePipe?: (target: DockerTarget) => Promise<void>;
  /**
   * `docker <args>` on the computer of the remote engine `target`, on the shell before the relay of its host
   * (RemoteShells.docker): for a call of an operation there that only reads (isShellCall) while the host has no Docker
   * pipe of the extension, so that the checks before a connection of the relay need no SSH login of their own; and for
   * each call of the work of the view Docker Hosts (isSharedShellCall, runWithDockerTarget with `onShell`), also on the
   * VM of Devspaces. Undefined when the host has no shell (the call logs in with `ssh://<host>`). With `login: false`
   * (runWithDockerTarget with `openLoginOnly`), only on a shell that is open or logging in, never with a new login.
   */
  remoteShell?: (target: DockerTarget, args: readonly string[], options: Pick<RunOptions, 'timeoutMs' | 'signal'> & { login?: boolean }) => Promise<RunResult | undefined>;
  /**
   * The Docker CLI of Devspaces when it is installed (presentOwnDockerCli), else undefined: the CLI of the calls of an
   * operation on a remote engine, in place of the Docker CLI of this computer, which such calls take only without it.
   */
  ownCli?: () => string | undefined;
  /**
   * Changes the environment `env` of a call that logs in with `ssh://<host>`, so that the `ssh` of the Docker CLI uses
   * the key of Devspaces when that host has it (SshKeyOffer.dockerSshEnv).
   */
  sshEnv?: (host: string, env: NodeJS.ProcessEnv) => void;
  /**
   * The source of the mount of the Docker socket of the engine of the operation `target` (undefined: the local Docker
   * outside an operation), a path on the computer of that engine, for the build container of buildImage: the socket
   * mount of the worker there. Default: /var/run/docker.sock.
   */
  engineSocket?: (target: DockerTarget | undefined) => Promise<string>;
  /** Only for tests. Default: SSH_DROP_RETRY_DELAY_MS. */
  sshDropRetryDelayMs?: number;
  /** Only for tests. Default: cliFileIdentity. */
  fileIdentity?: (path: string) => Promise<string | undefined>;
}

/** Time limit of `docker rm -f` of a build container after a cancel or a failure of its `docker run`. */
export const BUILD_CONTAINER_REMOVE_TIMEOUT_MS = 60_000;

/**
 * The wait before the second `docker rm -f` of a build container that the first one did not find: a cancel can come
 * while the Docker CLI creates the container, which then stays created and never starts (`--rm` acts only after a start).
 */
export const BUILD_CONTAINER_REMOVE_AGAIN_MS = 10_000;

/** Time limit of the pull of the build image (about 30 MB); after it, the build runs with `docker build`. */
export const BUILDX_PULL_TIMEOUT_MS = 10 * 60_000;

/**
 * The identity of the file at `path`: its inode, size and modification time (fs.stat, which follows a link). Another
 * value means another file, for example Docker Engine installed after the package podman-docker was removed.
 * Undefined when the file cannot be read.
 */
export async function cliFileIdentity(path: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** `promise`, or an AbortError as soon as `signal` aborts; the work of `promise` goes on for its other callers. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** False for a Docker call that does not reach the engine: a command of the Docker contexts, or only global options. */
function reachesEngine(args: readonly string[]): boolean {
  const [command] = dockerCommandWords(args);
  return command !== undefined && command !== 'context';
}

/**
 * A call that may run with the Docker CLI of the other computer, on the shell before the relay (runOnShell): it only
 * reads (isReadOnlyDockerCall) and reaches the engine, starts with its command (no global option, which names files or
 * an endpoint of this computer), and is no `docker version`, whose client part is that of the CLI that runs it.
 */
export function isShellCall(args: readonly string[]): boolean {
  return shellCarries(args) && isReadOnlyDockerCall(args);
}

/**
 * The calls that change something and that the shared shell of a host runs too (runWithDockerTarget with `onShell`):
 * the actions of the view Docker Hosts, which name their objects by ID or reference and need nothing of this computer.
 */
const SHARED_SHELL_CHANGES: Readonly<Record<string, readonly string[]>> = {
  container: ['stop', 'start', 'rm'],
  image: ['rm'],
  volume: ['rm'],
  network: ['rm'],
};

/**
 * A call that may run on the shared shell of a host (runWithDockerTarget with `onShell`): one of isShellCall, one of
 * the actions of the view Docker Hosts (SHARED_SHELL_CHANGES), or the reader of the shared volumes of its reports
 * (isVolumeReaderCall: a container without network that only reads the volumes, with its script as an argument). On the
 * VM of Devspaces (`vm`) also `docker builder prune` (Remove Unused Build Cache…): on another host, the Docker CLI there
 * could send it to a buildx builder that its user chose (`docker buildx use --global`) instead of the engine, so it
 * keeps the way of BootstrapDocker with BUILDX_BUILDER=default (REMOTE_BUILDX_BUILDER); the VM has no builder of a user.
 */
export function isSharedShellCall(args: readonly string[], vm: boolean): boolean {
  if (isShellCall(args) || isVolumeReaderCall(args)) return true;
  const [command, subcommand] = dockerCommandWords(args);
  if (!shellCarries(args) || command === undefined) return false;
  if (vm && command === 'builder' && subcommand === 'prune') return true;
  return SHARED_SHELL_CHANGES[command]?.includes(subcommand ?? '') ?? false;
}

/** A call that starts with its command (no global option of this computer), reaches the engine, and is no `docker version`. */
function shellCarries(args: readonly string[]): boolean {
  const [command] = dockerCommandWords(args);
  if (args.length === 0 || args[0].startsWith('-') || command === 'version') return false;
  return reachesEngine(args);
}

/**
 * The variables of the Docker CLI that a call of an operation on a remote engine goes without: its endpoint is the
 * Docker pipe of the extension or `ssh://<host>` (DOCKER_HOST), and the context and the TLS settings of an endpoint of
 * the user do not apply to it. BUILDX_BUILDER names a builder of the user (for example a Build Cloud builder): with it,
 * buildx would run `docker builder prune` on that builder, not on the engine of DOCKER_HOST. callEnv sets it to
 * REMOTE_BUILDX_BUILDER instead.
 */
const REMOTE_CLEARED_VARIABLES = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER'];

/**
 * The buildx builder of a call on a remote engine: `default`, the builder of the context `default`, which is the engine
 * of DOCKER_HOST. It also applies when the configuration of the user sends `docker builder` to buildx (the alias of the
 * old `docker buildx install`) with a builder chosen by `docker buildx use --global` (verified with Docker 29.9 and
 * buildx 0.38). A Docker CLI without buildx does not read it.
 */
const REMOTE_BUILDX_BUILDER = 'default';

/** The Docker CLI of the bootstrap (see the module comment). */
export class BootstrapDocker {
  private path: string | undefined;
  private env: NodeJS.ProcessEnv;
  private readonly rawEnv: NodeJS.ProcessEnv;
  private readonly findDocker: BootstrapDockerOptions['findDocker'];
  private readonly clock: Clock;
  private readonly onDaemonStatus: BootstrapDockerOptions['onDaemonStatus'];
  private readonly onCliLost: BootstrapDockerOptions['onCliLost'];
  private readonly onCliFound: BootstrapDockerOptions['onCliFound'];
  private readonly dockerPipe: BootstrapDockerOptions['dockerPipe'];
  private readonly servePipe: BootstrapDockerOptions['servePipe'];
  private readonly remoteShell: BootstrapDockerOptions['remoteShell'];
  private readonly sshEnv: BootstrapDockerOptions['sshEnv'];
  private readonly ownCli: BootstrapDockerOptions['ownCli'];
  private readonly engineSocket: BootstrapDockerOptions['engineSocket'];
  private readonly sshDropRetryDelayMs: number;
  private lookedUpAt: number | undefined;
  private readonly fileIdentity: (path: string) => Promise<string | undefined>;
  /**
   * The check of `docker --version` (podmanCli) for the CLI at `path`, whose file had `identity` when it started: its
   * answer (the detail of the Podman CLI, or none), which overlapping callers share while it runs.
   */
  private cliCheck: { path: string; identity: string | undefined; answer: Promise<string | undefined>; done: boolean } | undefined;

  /**
   * @param dockerPath Full path of the Docker CLI (see `findDockerCli`), or `undefined` if Docker is not installed.
   * @param env Process environment for Docker calls. The adapter applies `dockerProcessEnv` to it (idempotent), so that
   *   credential helpers and CLI plugins are found also with a short PATH.
   * @param platform Only for tests. Default: the platform of this process.
   * @param options `findDocker`: look the CLI up again while it is missing (see BootstrapDockerOptions).
   */
  constructor(
    private readonly runner: ProcessRunner,
    dockerPath: string | undefined,
    env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
    options: BootstrapDockerOptions = {},
  ) {
    this.path = dockerPath;
    this.rawEnv = env;
    this.env = dockerProcessEnv(env, platform, dockerPath);
    this.findDocker = options.findDocker;
    this.clock = options.clock ?? systemClock;
    this.onDaemonStatus = options.onDaemonStatus;
    this.onCliLost = options.onCliLost;
    this.onCliFound = options.onCliFound;
    this.dockerPipe = options.dockerPipe;
    this.servePipe = options.servePipe;
    this.remoteShell = options.remoteShell;
    this.sshEnv = options.sshEnv;
    this.ownCli = options.ownCli;
    this.engineSocket = options.engineSocket;
    this.sshDropRetryDelayMs = options.sshDropRetryDelayMs ?? SSH_DROP_RETRY_DELAY_MS;
    this.fileIdentity = options.fileIdentity ?? cliFileIdentity;
    // The caller has just looked the CLI up.
    this.lookedUpAt = this.clock.now();
  }

  /** Full path of the Docker CLI of this computer, or `undefined` while it is not found. */
  get dockerPath(): string | undefined {
    return this.path;
  }

  /**
   * True if a Docker CLI runs the calls here: within an operation on a remote engine the Docker CLI of Devspaces or of
   * this computer (canRunRemote), else the Docker CLI of this computer. With `findDocker`, a missing CLI is looked up
   * again first.
   */
  isInstalled(): boolean {
    return this.cliPath() !== undefined;
  }

  /**
   * True if a Docker CLI runs the calls of an operation on a remote engine: the Docker CLI of Devspaces (ownCli) or of
   * this computer. With `findDocker`, a missing CLI of this computer is looked up again first.
   */
  canRunRemote(): boolean {
    this.lookUpCliIfMissing();
    // The Docker CLI of this computer first: the one of Devspaces is looked up on disk at each call.
    return this.path !== undefined || this.ownCliPath() !== undefined;
  }

  /**
   * True if a Docker CLI runs the calls on an engine of the kind of `target`, also outside of an operation: on a remote
   * engine canRunRemote, else the Docker CLI of this computer. For the checks before a flow on that engine, for example
   * the worker's read of a container of a remote devspace on a computer without Docker.
   */
  canRunOn(target: Pick<DockerTarget, 'kind'>): boolean {
    if (target.kind === 'remote') return this.canRunRemote();
    this.lookUpCliIfMissing();
    return this.path !== undefined;
  }

  /**
   * The Docker CLI of the calls here: within an operation on a remote engine the Docker CLI of Devspaces when it is
   * installed, else the Docker CLI of this computer (looked up again first while it is missing, with `findDocker`).
   */
  private cliPath(): string | undefined {
    this.lookUpCliIfMissing();
    return (operationDockerTarget()?.kind === 'remote' ? this.ownCliPath() : undefined) ?? this.path;
  }

  /** The Docker CLI of Devspaces (ownCli), or undefined (also when its lookup fails, logged). */
  private ownCliPath(): string | undefined {
    try {
      return this.ownCli?.();
    } catch (error) {
      this.logger.warn(`The Docker CLI of Devspaces could not be looked up: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Raw call with the Docker CLI of this computer. Resolves also for a non-zero exit code. Throws
   * UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled) without a CLI, or when the CLI cannot be started
   * anymore (removed after it was found). A call that only reads is repeated once when the SSH server of a remote Docker
   * host closed the connection before the login (sshDroppedReadCall). A call that does not only read is logged with its
   * command (directCommandName; never its arguments or its input), its exit code, and its time.
   */
  run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runVia(args, options, true);
  }

  /**
   * run, with `ssh://<host>` of the operation also while its host has the Docker pipe of the extension (dockerPipe): for
   * the checks of a new connection of the relay, which must not depend on another connection to the host.
   */
  runWithoutPipe(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runVia(args, options, false);
  }

  /** run, through the Docker pipe of the extension when `viaPipe` and the host has one (operationEnv). */
  private async runVia(args: readonly string[], options: RunOptions, viaPipe: boolean): Promise<RunResult> {
    if (isReadOnlyDockerCall(args)) return this.runRepeated(args, options, viaPipe);
    return this.logged(args, () => this.runRepeated(args, options, viaPipe));
  }

  /** `call` of `docker <args>`, logged with its command (directCommandName), its exit code, and its time. */
  private async logged(args: readonly string[], call: () => Promise<RunResult>): Promise<RunResult> {
    const startedAt = this.clock.now();
    const command = directCommandName(args);
    const seconds = (): string => (Math.max(0, this.clock.now() - startedAt) / 1000).toFixed(1);
    try {
      const result = await call();
      const end = result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
      this.logger.info(`docker ${command}: ${end} after ${seconds()} s.`);
      return result;
    } catch (error) {
      this.logger.info(`docker ${command}: ${isAbortError(error) ? 'cancelled' : 'failed'} after ${seconds()} s.`);
      throw error;
    }
  }

  /** runOnce, repeated once after an SSH drop of a call that only reads (sshDroppedReadCall). */
  private async runRepeated(args: readonly string[], options: RunOptions, viaPipe: boolean): Promise<RunResult> {
    const result = await this.runOnce(args, options, viaPipe);
    if (!sshDroppedReadCall(args, result) || options.signal?.aborted) return result;
    const command = dockerCommandWords(args).join(' ');
    this.logger.warn(
      `docker ${command}: the SSH server of the Docker host closed the connection before the login. Trying once more in ${this.sshDropRetryDelayMs / 1000} s.`,
    );
    await sleep(this.sshDropRetryDelayMs, options.signal);
    return this.runOnce(args, options, viaPipe);
  }

  private async runOnce(args: readonly string[], options: RunOptions, viaPipe: boolean): Promise<RunResult> {
    const dockerPath = this.cliPath();
    if (dockerPath === undefined) throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled);
    try {
      if (options.env === undefined) await this.servePipeOf(operationDockerTarget());
      // The environment after the lookup: a CLI that was found again has its own (dockerProcessEnv).
      const call = options.env === undefined ? this.callEnv(viaPipe) : { env: options.env };
      // The work in the background on an SSH host goes only through the connection of the relay of this window to it
      // (runWithDockerTarget, `withoutLogin`): without that connection, neither `ssh://<host>` nor the shell before the
      // relay, which could log in too. The work stops, and a caller that joined its build builds for itself.
      const withoutLogin = options.env === undefined ? operationWithoutLogin() : undefined;
      if (withoutLogin !== undefined && call.login !== undefined && reachesEngine(args)) {
        this.logger.info(`${commandText(args)} does not run: the work in the background on ${call.login} uses only the connection of this window to the host, and that connection is not open.`);
        withoutLogin.abort(abortError());
        throw abortError();
      }
      // The read of the sizes of the utilization page in the background (runWithDockerTarget, `openLoginOnly`): only on
      // the shell that is open, or through the pipe of an SSH host (the login of the relay); never a new login.
      const openLoginOnly = options.env === undefined ? operationOpenLoginOnly() : undefined;
      const onShell = call.shellTarget === undefined ? undefined : await this.runOnShell(call.shellTarget, args, options, call.shared === true, openLoginOnly === undefined);
      if (onShell !== undefined) return onShell;
      const target = operationDockerTarget();
      if (openLoginOnly !== undefined && target?.kind === 'remote' && reachesEngine(args) && (call.shellTarget !== undefined || call.login !== undefined || isVmHost(target.host))) {
        this.logger.info(`${commandText(args)} does not run: it may use only a login to ${target.host} that is open (the shared shell, or the connection of the relay), and it cannot run there.`);
        openLoginOnly.abort(abortError());
        throw abortError();
      }
      if (call.noEndpoint !== undefined) {
        throw new UserFacingError(
          'dockerHostUnreachable',
          Messages.dockerHostUnreachable(call.noEndpoint, dockerHostReason('pipeNotListening', call.noEndpoint)),
          `${commandText(args)} has no way to ${call.noEndpoint}: the Docker pipe of the extension for it does not listen (the log says why).`,
        );
      }
      // Each such call is one SSH login of the Docker CLI (`ssh … docker system dial-stdio`), which SSH servers limit.
      // The commands of the Docker contexts and `docker --version` do not reach the engine.
      if (call.login !== undefined && reachesEngine(args)) this.logger.info(`${commandText(args)} logs in to ${call.login} over SSH.`);
      return await this.runner.run(dockerPath, args, { ...options, env: call.env });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        if (this.findDocker && this.path === dockerPath) {
          // For example while Docker Desktop updates itself: the next call looks for the CLI again (unless `onCliLost`
          // looks it up first, see BootstrapDockerOptions).
          this.path = undefined;
          this.lookedUpAt = undefined;
          this.reportCliLost();
        }
        throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled, `${dockerPath}: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  /**
   * The helper channel: starts `docker <args>` with standard input open, with the environment of `run` (within an
   * operation: its local Docker context, or `ssh://<host>`). Undefined without a Docker CLI, when the runner cannot
   * start such a program, and within an operation on the VM of Devspaces (its WSL distribution or its Lima VM), whose
   * worker starts only behind the relay (`wsl.exe`, or the SSH of Lima).
   */
  start(args: readonly string[]): StartedProcess | undefined {
    const dockerPath = this.cliPath();
    if (dockerPath === undefined || this.runner.start === undefined) return undefined;
    const target = operationDockerTarget();
    if (target?.kind === 'remote' && isVmHost(target.host)) return undefined;
    return this.runner.start(dockerPath, args, { env: this.operationEnv(false) });
  }

  /**
   * The environment of a Docker call. Within an operation (dockerTargets.ts) on a remote engine, the call gets
   * DOCKER_HOST without DOCKER_CONTEXT and the TLS variables of the Docker CLI: the Docker pipe of the extension for that
   * host while a connection of the relay to it is open (`viaPipe`, dockerPipe; the pipe is a socket of this computer),
   * else `ssh://<host>`, so that the context and DOCKER_HOST of the user never decide where it goes. For the WSL
   * distribution of Devspaces, always its pipe (it needs no connection of the relay), and no `ssh://`. Within an operation
   * on the local Docker that read its Docker context, the call gets DOCKER_CONTEXT with that context's name, so the whole
   * operation stays on the Docker it started with, even when the user switches the context meanwhile. Otherwise the
   * environment is the one of VS Code: when DOCKER_HOST is set there, it decides the endpoint, and the operation has no
   * context name.
   */
  private operationEnv(viaPipe: boolean): NodeJS.ProcessEnv {
    return this.callEnv(viaPipe).env;
  }

  /**
   * operationEnv, and the SSH host that a call with it logs in to with `ssh://<host>`: the remote target of the operation
   * without the pipe (also `shellTarget`, for runOnShell).
   */
  private callEnv(viaPipe: boolean): { env: NodeJS.ProcessEnv; login?: string; shellTarget?: DockerTarget; noEndpoint?: string; shared?: boolean } {
    const target = operationDockerTarget();
    if (target === undefined) return { env: this.env };
    if (target.kind === 'remote') {
      // The pipe for the VM of Devspaces never depends on a connection of the relay, so `viaPipe` does not matter.
      const vm = isVmHost(target.host);
      const pipe = viaPipe || vm ? this.pipeOf(target) : undefined;
      const shared = operationOnShell();
      const env: NodeJS.ProcessEnv = { ...this.env };
      for (const name of REMOTE_CLEARED_VARIABLES) deleteEnv(env, name);
      env.BUILDX_BUILDER = REMOTE_BUILDX_BUILDER;
      // For the VM of Devspaces without its pipe: `wsl://<distribution>` or `lima://devspaces` (hostEndpoint). No call runs
      // with it (`noEndpoint` below, and `start` starts nothing there); should one run anyway, the Docker CLI refuses it.
      env.DOCKER_HOST = pipe ?? hostEndpoint(target.host);
      // The pipe of an SSH host shares the login of the relay. The pipe of the VM makes a connection of its own for each
      // call, so the work on the shared shell goes to the shell there, and through the pipe only what the shell cannot carry.
      if (pipe !== undefined) return shared && vm ? { env, shellTarget: target, shared } : { env };
      // No `ssh://` for it: a call that only reads runs on the shell before the relay, any other one fails.
      if (vm) return { env, shellTarget: target, noEndpoint: target.host, shared };
      this.sshEnv?.(target.host, env);
      return { env, login: target.host, shellTarget: target, shared };
    }
    if (target.context === undefined) return { env: this.env };
    const env: NodeJS.ProcessEnv = { ...this.env };
    deleteEnv(env, 'DOCKER_CONTEXT');
    env.DOCKER_CONTEXT = target.context;
    return { env };
  }

  /**
   * `docker <args>` on the shell before the relay of the SSH host of `target` (remoteShell), for a call that only reads
   * (isShellCall), or with `shared` (the shared shell, runWithDockerTarget with `onShell`) for one of isSharedShellCall,
   * without input, folder or output listeners; undefined when it cannot go there, and the call logs in with
   * `ssh://<host>` then (on the VM of Devspaces: through its pipe). A failure of the shell itself is logged and gives
   * undefined too. A shell that ends during the command gives its result (exit code 255), so a call that changes
   * something never runs twice.
   */
  private async runOnShell(target: DockerTarget, args: readonly string[], options: RunOptions, shared: boolean, login: boolean): Promise<RunResult | undefined> {
    if (this.remoteShell === undefined || !(shared ? isSharedShellCall(args, isVmHost(target.host)) : isShellCall(args))) return undefined;
    if (options.input !== undefined || options.cwd !== undefined || options.onStdout !== undefined || options.onStderr !== undefined) return undefined;
    try {
      return await this.remoteShell(target, args, { timeoutMs: options.timeoutMs, signal: options.signal, ...(login ? {} : { login: false }) });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const next = !login ? 'and it may not log in' : isVmHost(target.host) ? 'so it needs the Docker pipe of the extension' : 'so it logs in over SSH itself';
      this.logger.warn(`docker ${dockerCommandWords(args).join(' ')} could not run on the shell before the relay on ${target.host}, ${next}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** servePipe for the remote engine `target`, if any (it never rejects; a failure of the hook itself is logged). */
  private async servePipeOf(target: DockerTarget | undefined): Promise<void> {
    if (target?.kind !== 'remote' || this.servePipe === undefined) return;
    try {
      await this.servePipe(target);
    } catch (error) {
      this.logger.warn(`The Docker pipe of ${target.host} could not be served: ${errorMessage(error)}`);
    }
  }

  /** The Docker pipe of the extension for `target` (dockerPipe), or undefined (also when the lookup fails, logged). */
  private pipeOf(target: DockerTarget): string | undefined {
    try {
      return this.dockerPipe?.(target);
    } catch (error) {
      this.logger.warn(`The Docker pipe of ${target.host} could not be looked up, so the call logs in itself: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** A copy of the environment of the Docker calls outside of an operation. */
  processEnv(): NodeJS.ProcessEnv {
    return { ...this.env };
  }

  /**
   * True if the Docker CLI was found. With `findDocker`, a missing CLI is looked up again now, without the waiting time
   * of `isInstalled` (after an installation was started, the CLI is looked up more often).
   */
  lookUpCliNow(): boolean {
    this.lookUpCliIfMissing(true);
    return this.path !== undefined;
  }

  private reportCliLost(): void {
    try {
      this.onCliLost?.();
    } catch (error) {
      this.logger.warn(`The lost Docker CLI could not be reported: ${errorMessage(error)}`);
    }
  }

  /** With `findDocker`: looks for a missing CLI again, at most every DOCKER_CLI_LOOKUP_RETRY_MS unless `force` is set. */
  private lookUpCliIfMissing(force = false): void {
    if (this.path !== undefined || !this.findDocker) return;
    const now = this.clock.now();
    if (!force && this.lookedUpAt !== undefined && Math.abs(now - this.lookedUpAt) < DOCKER_CLI_LOOKUP_RETRY_MS) return;
    this.lookedUpAt = now;
    let found: string | undefined;
    try {
      found = this.findDocker(this.rawEnv, this.platform);
    } catch (error) {
      this.logger.warn(`The Docker CLI could not be looked up: ${errorMessage(error)}`);
      return;
    }
    if (found === undefined) return;
    this.path = found;
    this.env = dockerProcessEnv(this.rawEnv, this.platform, found);
    this.logger.info(`Docker CLI: ${found}`);
    try {
      this.onCliFound?.(found);
    } catch (error) {
      this.logger.warn(`The found Docker CLI could not be reported: ${errorMessage(error)}`);
    }
  }

  /** Like run, but throws CommandError on a non-zero exit code (also after a timeout); returns stdout. */
  async runChecked(args: readonly string[], options?: RunOptions): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) throw this.commandError(args, result);
    return result.stdout;
  }

  /**
   * `docker info`: whether the Docker engine answers. Never throws, except an AbortError when the signal aborts.
   * Without a CLI, the engine counts as not running.
   */
  async daemonStatus(signal?: AbortSignal, timeoutMs: number = DOCKER_INFO_TIMEOUT_MS): Promise<DaemonStatus> {
    const status = await this.queryDaemonStatus(signal, timeoutMs);
    try {
      this.onDaemonStatus?.(status.running);
    } catch (error) {
      this.logger.warn(`The Docker state could not be reported: ${errorMessage(error)}`);
    }
    return status;
  }

  private async queryDaemonStatus(signal: AbortSignal | undefined, timeoutMs: number): Promise<DaemonStatus> {
    if (!this.isInstalled()) return { running: false, detail: 'The Docker CLI was not found.' };
    let result: RunResult;
    try {
      // The check whether Docker runs comes before the worker (which needs it), so "Docker is not running" stays its
      // own answer. A direct call, like every call of this CLI.
      result = await this.run(['info', '--format', '{{json .ServerVersion}}'], { signal, timeoutMs });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { running: false, detail: errorMessage(error) };
    }
    if (result.timedOut) {
      return { running: false, detail: `docker info did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    }
    if (result.exitCode !== 0) {
      return { running: false, detail: (result.stderr || result.stdout).trim() || `docker info failed with exit code ${result.exitCode}.` };
    }
    // Some versions print the client part and an empty server version when the engine cannot be reached.
    const version = parseJsonOutput(result.stdout);
    if (typeof version !== 'string' || !version) {
      return { running: false, detail: result.stderr.trim() || 'docker info returned no server version.' };
    }
    return { running: true, detail: `Docker engine ${version}` };
  }

  /** `docker info` exit code 0 (time limit 20 s). False without a CLI. Rejects only with an AbortError. */
  async isRunning(signal?: AbortSignal): Promise<boolean> {
    return (await this.daemonStatus(signal)).running;
  }

  /**
   * Podman instead of Docker, which Devspaces does not support: the detail for the log, or undefined for Docker.
   * - The CLI is Podman: `docker --version` prints "podman version …" (PODMAN_CLI_VERSION). It needs no engine; the
   *   answer is kept for the file of the CLI (podmanCli).
   * - With `engineAnswers` (the engine answered `docker info`): the engine is Podman. `docker version` names the
   *   component "Podman Engine" (the Docker-compatible API of Podman behind the Docker CLI). Within an operation, this
   *   is the engine of the operation.
   * A call that fails counts as Docker. Rejects only with an AbortError.
   */
  // Assumption: these outputs identify Podman 3 to 5 and its package podman-docker (not checked with a real Podman).
  async podmanInUse(engineAnswers: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const cli = await this.podmanCli(signal);
    if (cli !== undefined || !engineAnswers) return cli;
    const result = await this.podmanCheckCall(['version', '--format', '{{json .Server}}'], signal);
    if (result === undefined || result.exitCode !== 0) return undefined;
    const server = parseJsonOutput(result.stdout);
    const components = isRecord(server) && Array.isArray(server.Components) ? (server.Components as unknown[]) : [];
    for (const component of components) {
      if (isRecord(component) && typeof component.Name === 'string' && PODMAN_ENGINE_COMPONENT.test(component.Name)) {
        return `docker version: the engine is ${component.Name}${typeof component.Version === 'string' ? ` ${component.Version}` : ''}.`;
      }
    }
    return undefined;
  }

  /**
   * The CLI part of podmanInUse: the detail when `docker --version` prints "podman version …" (for example the package
   * podman-docker), else undefined. The answer is kept for the file of the CLI (cliFileIdentity): another file at its
   * path, or a file that cannot be read, is asked again, so a user who replaced podman-docker with Docker needs no
   * reload. Callers that overlap share one call. A call that fails counts as Docker and is not kept. DockerTargets asks
   * it when the current context cannot be read. Rejects only with an AbortError.
   */
  async podmanCli(signal?: AbortSignal): Promise<string | undefined> {
    const path = this.path;
    if (path === undefined) return undefined;
    const identity = await this.fileIdentity(path);
    if (signal?.aborted) throw abortError();
    const known = this.cliCheck;
    if (known !== undefined && known.path === path && (!known.done || (identity !== undefined && known.identity === identity))) {
      return untilAborted(known.answer, signal);
    }
    return untilAborted(this.checkCli(path, identity), signal);
  }

  /**
   * Runs `docker --version` for podmanCli, without the signal of a caller (others may share it), and keeps the check.
   * A call that fails or rejects is not kept: it is asked again next time.
   */
  private checkCli(path: string, identity: string | undefined): Promise<string | undefined> {
    const check = { path, identity, answer: Promise.resolve<string | undefined>(undefined), done: false };
    const forget = (): void => {
      check.done = true;
      if (this.cliCheck === check) this.cliCheck = undefined;
    };
    // With the CLI at `path`, the one of this computer, also within an operation on a remote engine.
    check.answer = outsideOperation(() => this.podmanCheckCall(['--version'], undefined)).then(
      (result) => {
        if (result === undefined || result.exitCode !== 0) {
          forget();
          return undefined;
        }
        check.done = true;
        return PODMAN_CLI_VERSION.test(result.stdout) ? `docker --version: ${result.stdout.trim()}` : undefined;
      },
      (error: unknown) => {
        forget();
        throw error;
      },
    );
    this.cliCheck = check;
    return check.answer;
  }

  /** A call of podmanInUse: undefined when it could not run (logged). Rejects only with an AbortError. */
  private async podmanCheckCall(args: readonly string[], signal: AbortSignal | undefined): Promise<RunResult | undefined> {
    try {
      return await this.run(args, { signal, timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.logger.warn(`docker ${args[0]} could not run, so Docker is assumed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** True if the image exists locally. Throws CommandError for other errors (for example an invalid reference). */
  async imageExists(reference: string): Promise<boolean> {
    const args = ['image', 'inspect', '--format', '{{json .Id}}', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0) return true;
    if (this.isMissing(result)) return false;
    throw this.commandError(args, result);
  }

  /** ID of a local image (`sha256:…`), or `undefined` if it does not exist. Throws CommandError for other errors. */
  async imageId(reference: string): Promise<string | undefined> {
    const args = ['image', 'inspect', '--format', '{{json .Id}}', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      if (this.isMissing(result)) return undefined;
      throw this.commandError(args, result);
    }
    const id = parseJsonOutput(result.stdout);
    if (typeof id !== 'string' || id === '') throw this.commandError(args, result, 'Unexpected output of docker image inspect.');
    return id;
  }

  /**
   * Local images with a label (`docker image ls --filter label=<label> --no-trunc`, then the same with `--filter
   * dangling=true`), for example `nimblescape.devspaces.worker=true`. Dangling images are included, with no tags. One
   * entry per image ID, with all its tags. Throws CommandError.
   */
  async listImagesByLabel(label: string): Promise<ImageInfo[]> {
    const images = new Map<string, ImageInfo>();
    // The containerd image store lists dangling images only with `--filter dangling=true` (or `-a`). `-a` would also
    // list the intermediate images of the classic builder, which are not dangling.
    for (const filters of [[], ['--filter', 'dangling=true']]) {
      const args = ['image', 'ls', '--filter', `label=${label}`, ...filters, '--no-trunc', '--format', '{{json .}}'];
      const stdout = await this.runChecked(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
      for (const item of parseJsonLines(stdout)) {
        if (!isRecord(item) || typeof item.ID !== 'string' || item.ID === '') continue;
        let image = images.get(item.ID);
        if (!image) {
          image = { id: item.ID, tags: [], createdAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : '' };
          images.set(item.ID, image);
        }
        // A dangling image is listed as `<none>:<none>`.
        const { Repository: repository, Tag: tag } = item;
        if (typeof repository !== 'string' || typeof tag !== 'string') continue;
        if (!repository || !tag || repository === '<none>' || tag === '<none>') continue;
        const reference = `${repository}:${tag}`;
        if (!image.tags.includes(reference)) image.tags.push(reference);
      }
    }
    return [...images.values()];
  }

  /** docker image rm without force. Returns false if the image is missing or in use (never throws for these). */
  async removeImage(reference: string): Promise<boolean> {
    const args = ['image', 'rm', reference];
    const result = await this.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
    if (result.exitCode === 0) {
      this.logger.info(`Removed image ${reference}.`);
      return true;
    }
    if (this.isMissing(result)) return false;
    const message = `${result.stderr}\n${result.stdout}`;
    if (IMAGE_IN_USE_PATTERN.test(message)) {
      this.logger.info(`Image ${reference} is in use and was not removed: ${result.stderr.trim()}`);
      return false;
    }
    throw this.commandError(args, result);
  }

  /**
   * Builds the image `tag` from `dockerfile` and the folder `context`, as `docker build -t <tag> -f <dockerfile> [--pull]
   * [--no-cache] [--label k=v]… --label nimblescape.devspaces.build-id=<nonce> [--build-arg k=v]… <context>`. `pull`: pull the base images even if they exist locally; `noCache`: build every step
   * again. Docker moves the tag only when the build succeeds. Throws CommandError when the build fails.
   *
   * Returns the ID of the image that this build made, found by its build label (LABEL_BUILD_ID with a random nonce of
   * this build, listImagesByLabel, which also lists a dangling image), not by the tag, which another build may have
   * moved meanwhile. No `--iidfile`: the Docker CLI fails after a successful build when it cannot write the file (a
   * Docker CLI outside the sandbox of VS Code), and with the containerd image store the file may hold a digest that
   * does not resolve. The lookup never decides whether the build succeeded: when it fails, or does not find exactly one
   * image, the result is `undefined` (with a warning).
   *
   * The build runs in a container of the build image of Devspaces on the engine (buildInContainer): buildx with
   * BuildKit, the same on every engine, whatever Docker CLI sends the calls. It falls back to `docker build` of the
   * Docker CLI here when the Dockerfile is not at the top of its context folder, when the build image cannot be
   * prepared (for example without a connection to Docker Hub), and when Docker cannot run the container.
   */
  async buildImage(options: {
    tag: string;
    dockerfile: string;
    context: string;
    labels?: Record<string, string>;
    buildArgs?: Record<string, string>;
    pull?: boolean;
    noCache?: boolean;
    onOutput?: (text: string) => void;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    const flags = [...(options.pull ? ['--pull'] : []), ...(options.noCache ? ['--no-cache'] : [])];
    const flagText = flags.length > 0 ? ` (${flags.join(' ')})` : '';
    const onOutput = options.onOutput ?? ((text: string) => this.logger.output(text));
    const buildLabel = `${LABEL_BUILD_ID}=${crypto.randomBytes(16).toString('hex')}`;
    const labels = [...labelArgs(options.labels, '--label'), '--label', buildLabel, ...labelArgs(options.buildArgs, '--build-arg')];
    const rest = [...flags, ...labels];
    const output: RunOptions = { signal: options.signal, onStdout: onOutput, onStderr: onOutput };
    // The build container pulls nothing itself: `--pull` is the pull of the base images before it.
    if (!(await this.buildInContainer(options, [...(options.noCache ? ['--no-cache'] : []), ...labels], `${options.tag}${flagText}`, output))) {
      this.logger.info(`Building image ${options.tag}${flagText} with \`docker build\`.`);
      await this.runChecked(['build', '-t', options.tag, '-f', options.dockerfile, ...rest, options.context], output);
    }
    let images: ImageInfo[];
    try {
      images = await this.listImagesByLabel(buildLabel);
    } catch (error) {
      this.logger.warn(`The ID of the image ${options.tag} that was just built could not be read: ${errorMessage(error)}`);
      return undefined;
    }
    if (images.length !== 1) {
      this.logger.warn(`The image ${options.tag} that was just built was found ${images.length} times by its build label. Its ID is not used.`);
      return undefined;
    }
    return images[0].id;
  }

  /**
   * The build of buildImage in a container of the build image on the engine (buildxImage.ts): `docker run --rm -i …
   * devspaces-buildx:<version> build … -t <tag> -f <name of the Dockerfile> … -`, with the context as a tar archive on
   * its standard input (contextTar), and the Docker socket of the engine (engineSocket). The container has no network,
   * and buildx would fetch the token of a registry itself, so the engine first pulls the base images of the Dockerfile
   * (pullBaseImages: with `pull`, or when one is missing), with the logins of the Docker CLI and the proxy of the
   * engine, as `docker build` does; the build then finds them on the engine. True when it built the image. False
   * (logged) when it cannot run there: a Dockerfile that is not at the top of its context folder, a context that cannot
   * be packed, a Dockerfile without a base image that can be read (each FROM must name its image in a form that
   * extractBaseImages reads, as the helper Dockerfile does, because the build cannot pull one itself), a build image that cannot be prepared (buildxImage),
   * or Docker that cannot create or start the container (exit code 125); buildImage then runs `docker build`. Throws
   * CommandError when the pull of a base image or the build failed, and an AbortError when `output.signal` aborts. After a cancel or a failure of its `docker run`, the container is
   * removed (removeBuildContainer): the Docker CLI on Windows ends without stopping it.
   */
  private async buildInContainer(
    options: { tag: string; dockerfile: string; context: string; buildArgs?: Record<string, string>; pull?: boolean },
    rest: readonly string[],
    image: string,
    output: RunOptions,
  ): Promise<boolean> {
    const fallback = 'so the image is built with `docker build`';
    if (path.resolve(path.dirname(options.dockerfile)) !== path.resolve(options.context)) {
      this.logger.warn(`The Dockerfile ${options.dockerfile} is not at the top of its build context ${options.context}, ${fallback}.`);
      return false;
    }
    let context: Buffer;
    let baseImages: string[];
    try {
      context = await contextTar(options.context);
      baseImages = extractBaseImages(await fs.promises.readFile(options.dockerfile, 'utf8'), options.buildArgs);
    } catch (error) {
      this.logger.warn(`The build context ${options.context} or its Dockerfile cannot be read, ${fallback}: ${errorMessage(error)}`);
      return false;
    }
    if (baseImages.length === 0) {
      this.logger.warn(`The base image of ${options.dockerfile} cannot be read, ${fallback}.`);
      return false;
    }
    const buildx = await this.buildxImage(output.signal);
    if (buildx === undefined) return false;
    const target = operationDockerTarget();
    let socket: string;
    try {
      socket = (await this.engineSocket?.(target)) ?? HELPER_DOCKER_SOCKET;
    } catch (error) {
      this.logger.warn(`The Docker socket of the engine could not be looked up, ${fallback}: ${errorMessage(error)}`);
      return false;
    }
    await this.pullBaseImages(baseImages, options.pull === true, output);
    const name = `${BUILD_CONTAINER_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
    const args = buildxRunArgs({ name, image: buildx, socket, tag: options.tag, dockerfile: path.basename(options.dockerfile), buildArgs: rest });
    this.logger.info(`Building image ${image} in the container ${name} with buildx ${BUILDX_PIN.version} (BuildKit).`);
    let result: RunResult;
    try {
      result = await this.run(args, { ...output, input: context });
    } catch (error) {
      // A cancel can come before the Docker CLI created the container.
      this.removeBuildContainer(name, isAbortError(error));
      throw error;
    }
    if (result.exitCode === 0) return true;
    this.removeBuildContainer(name);
    if (result.exitCode === DOCKER_RUN_FAILED_EXIT_CODE && !result.timedOut) {
      this.logger.warn(`Docker could not run the build container ${name}, ${fallback}: ${result.stderr.trim().slice(-500)}`);
      return false;
    }
    throw this.commandError(args, result);
  }

  /**
   * `docker pull` of each base image of a build in the build container, with `pull` always, else only when the engine
   * does not have it: the Docker CLI sends its logins, and the engine pulls through its proxy, as for `docker build
   * --pull`. Its output goes to the output of the build. A check that fails counts as missing. Throws CommandError
   * when a pull fails.
   */
  private async pullBaseImages(images: readonly string[], pull: boolean, output: RunOptions): Promise<void> {
    for (const base of images) {
      if (!pull && (await this.imageExists(base).catch(() => false))) continue;
      await this.runChecked(['pull', base], output);
    }
  }

  /**
   * The tag of the build image on the engine of the operation (buildxImageTag, `devspaces-buildx:<version>`). When it is
   * missing: the pinned image by its digest (buildxPulledReference), pulled when no image of that digest is there, gets
   * the tag; the name of that pull is removed again (only an image that was not there before the pull, so no name of
   * the user goes), so that the tag is its only name. The cleanup of the Monitor removes the tags of older versions
   * (src/remoteMonitor/engineCleanup.ts).
   * Undefined (logged) when it cannot be prepared, for example without a connection to Docker Hub. Rejects only with an
   * AbortError when `signal` aborts.
   */
  private async buildxImage(signal: AbortSignal | undefined): Promise<string | undefined> {
    const tag = buildxImageTag();
    const pinned = buildxPulledReference();
    // Whether the engine answered the first check, and whether this call pulled the pinned image itself.
    let checked = false;
    let pulled = false;
    try {
      if (await this.imageExists(tag)) return tag;
      checked = true;
      const present = await this.imageExists(pinned);
      if (!present) {
        this.logger.info(`Pulling the build image ${pinned} (buildx ${BUILDX_PIN.version}).`);
        const log = (text: string): void => this.logger.output(text);
        await this.runChecked(['pull', pinned], { signal, timeoutMs: BUILDX_PULL_TIMEOUT_MS, onStdout: log, onStderr: log });
        pulled = true;
      }
      await this.runChecked(['tag', pinned, tag], { signal, timeoutMs: DOCKER_QUERY_TIMEOUT_MS });
      if (pulled) await this.removePulledName(pinned);
      return tag;
    } catch (error) {
      // The name of a pull of its own goes also after a failure, so that no image without a tag of Devspaces stays.
      if (pulled) await this.removePulledName(pinned);
      if (isAbortError(error)) throw error;
      // Another window may have tagged it meanwhile (not asked again when the engine did not answer the first check).
      if (checked && (await this.imageExists(tag).catch(() => false))) return tag;
      this.logger.warn(`The build image ${pinned} could not be prepared, so the image is built with \`docker build\`: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * `docker image rm <pinned>` of the name of a pull of the build image by its digest: the image stays when it has the
   * tag of the build image. A failure is logged.
   */
  private async removePulledName(pinned: string): Promise<void> {
    const removed = await this.run(['image', 'rm', pinned], { timeoutMs: DOCKER_QUERY_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: errorMessage(error), timedOut: false }));
    if (removed.exitCode !== 0 && !this.isMissing(removed)) this.logger.warn(`The name ${pinned} of the pull of the build image stays: ${removed.stderr.trim()}`);
  }

  /**
   * `docker rm -f <name>` of a build container in the background, after a cancel or a failure of its `docker run`: the
   * build in it stops. A container that is not there (its `--rm`, or a cancel before its creation) is no failure; then
   * a second `docker rm -f` follows after BUILD_CONTAINER_REMOVE_AGAIN_MS when `again` is set (a cancel), for a
   * container that the Docker CLI created after the first one. Another failure is logged.
   */
  private removeBuildContainer(name: string, again = false): void {
    const failed = (detail: string): void => this.logger.warn(`The build container ${name} could not be removed, so its build may go on: ${detail}`);
    this.run(['rm', '-f', name], { timeoutMs: BUILD_CONTAINER_REMOVE_TIMEOUT_MS }).then(
      (result) => {
        if (result.exitCode === 0) return;
        // Gone already, or its `--rm` removes it now.
        if (!result.timedOut && /no such container|removal of container .* is already in progress/i.test(result.stderr)) {
          if (again) setTimeout(() => this.removeBuildContainer(name), BUILD_CONTAINER_REMOVE_AGAIN_MS).unref();
          return;
        }
        failed(result.timedOut ? 'no answer within the time limit' : result.stderr.trim());
      },
      (error: unknown) => failed(errorMessage(error)),
    );
  }

  /** The image of a failed call does not exist (IMAGE_MISSING_PATTERN). */
  private isMissing(result: RunResult): boolean {
    return !result.timedOut && result.exitCode !== 0 && IMAGE_MISSING_PATTERN.test(result.stderr);
  }

  private commandError(args: readonly string[], result: RunResult, note?: string): CommandError {
    const notes = [result.timedOut ? 'The command did not end within the time limit.' : undefined, note].filter(Boolean);
    const stderr = notes.length > 0 ? `${result.stderr.trimEnd()}\n${notes.join('\n')}`.trim() : result.stderr;
    return new CommandError(commandText(args), result.exitCode, result.stdout, stderr, result.timedOut);
  }
}
