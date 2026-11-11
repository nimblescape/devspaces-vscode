// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker host of an operation: the Docker host of Devspaces (RemoteDockerState), read at the start of each operation
// and never cached beyond it, so that a choice in another window takes effect for the next operation. A host of the
// list of Devspaces is reached over SSH or wsl.exe (remoteDockerTarget); without one, the operation has no Docker host
// (NO_DOCKER_HOST_TARGET), because Devspaces never uses the Docker of this computer. Only in the tests of the engine
// (computerDocker), the local Docker is the current Docker context
// (`docker context inspect`), or DOCKER_HOST; a context or DOCKER_HOST of the user that reaches a host over SSH is not
// supported there (isDockerContextHostTarget), because Devspaces reaches remote hosts only through its own list. An
// operation keeps the host it started with: its Docker calls get DOCKER_CONTEXT with the name of the local context that
// it read, or DOCKER_HOST of its remote host (BootstrapDocker.run), so a change in the middle does not move half of it to
// another engine.
import { AsyncLocalStorage } from 'async_hooks';
import { errorMessage } from '../errors';
import { Messages } from '../messages';
import type { Logger, RunOptions, RunResult } from '../ports';
import { envValue } from './dockerCli';
import { LOCAL_DOCKER_TARGET, dockerTargetOf, isVmHost, parseContextInspect, remoteDockerTarget, type DockerTarget } from './dockerHost';

/**
 * The target while Devspaces has no Docker host (isNoDockerHostTarget): it never uses the Docker of this computer
 * (docs/requirements.md R-ENG-001), so it counts as not supported: every operation refuses it
 * with Messages.noDockerHost, its host matches no devspace, and the sidebar shows the Docker setup.
 */
export const NO_DOCKER_HOST_TARGET: DockerTarget = { kind: 'unsupported', host: Messages.noDockerHostName, endpoint: '', noHost: true };

/**
 * The target when the current Docker context cannot be read and DOCKER_HOST is not set (isUnreadableDockerTarget).
 * Without the name of a context, the Docker calls would go to the context that the Docker CLI finds, perhaps on
 * another computer, while the operation would record the local Docker. So it counts as not supported: every
 * operation refuses it with a message, and its host matches no devspace.
 */
export const UNREADABLE_DOCKER_TARGET: DockerTarget = { kind: 'unsupported', host: Messages.unreadableDockerContextHost, endpoint: '' };

/**
 * The target when the current Docker context cannot be read, DOCKER_HOST is not set, and the docker command is Podman
 * (isPodmanDockerTarget; for example the package podman-docker: Podman has no Docker contexts). It counts as not
 * supported: every operation refuses it with Messages.podmanNotSupported, and its host matches no devspace. `detail`:
 * what showed Podman, for the log.
 */
export function podmanDockerTarget(detail: string): DockerTarget {
  return { kind: 'unsupported', host: Messages.podmanDockerHost, endpoint: '', podman: detail };
}

/**
 * The target of an operation while it runs. Timers and listeners that an operation creates keep its store after it
 * ended (AsyncLocalStorage); `active` is false then, so they read the current context again.
 */
interface OperationScope {
  target: DockerTarget;
  active: boolean;
  /** See runWithDockerTarget, `withoutLogin`. */
  withoutLogin?: AbortController;
  /** See runWithDockerTarget, `onShell`. */
  onShell?: boolean;
}

const operationTargets = new AsyncLocalStorage<OperationScope>();

/** The Docker target of the operation that runs now, if any. */
export function operationDockerTarget(): DockerTarget | undefined {
  const scope = operationTargets.getStore();
  return scope?.active ? scope.target : undefined;
}

/** Runs `fn` outside of any operation: its Docker calls read the current context themselves (attachDiagnostics.ts). */
export function outsideOperation<T>(fn: () => Promise<T>): Promise<T> {
  return operationTargets.exit(fn);
}

/**
 * The stop of the work in the background on an SSH host that runs now, if any (runWithDockerTarget, `withoutLogin`):
 * BootstrapDocker refuses each of its Docker calls that would log in to the host.
 */
export function operationWithoutLogin(): AbortController | undefined {
  const scope = operationTargets.getStore();
  return scope?.active ? scope.withoutLogin : undefined;
}

/**
 * Whether the Docker calls of the operation that runs now go to the shared shell of its host (runWithDockerTarget,
 * `onShell`).
 */
export function operationOnShell(): boolean {
  const scope = operationTargets.getStore();
  return scope?.active === true && scope.onShell === true;
}

/**
 * Runs `fn` as an operation on `target` (see the module comment). `withoutLogin`: the work in the background on an SSH
 * host (docs/requirements.md R-ENG-002), whose Docker calls go only through the connection of the relay of this window
 * to the host (the Docker pipe of the extension) and never log in themselves. BootstrapDocker refuses a call that would
 * log in (`ssh://<host>`, or the shell before the relay): it aborts this controller, whose signal the work passes on to
 * its calls, and throws an AbortError. An operation on the same host within such work stays without a login.
 * `onShell`: the work of the view Docker Hosts (R-ENG-008), whose Docker calls run on the one shared shell of the host
 * (the shell before the relay), also those that change something (isSharedShellCall) and also on the VM of Devspaces,
 * so that they share one login of the host instead of one connection each. A call on an SSH host still goes through
 * the Docker pipe while a connection of the relay to it is open: that pipe shares the login of the relay. An operation
 * on the same host within it keeps `onShell`.
 */
export async function runWithDockerTarget<T>(target: DockerTarget, fn: () => Promise<T>, options: { withoutLogin?: AbortController; onShell?: boolean } = {}): Promise<T> {
  const outer = operationTargets.getStore();
  const sameHost = outer?.active === true && outer.target.host === target.host;
  const withoutLogin = options.withoutLogin ?? (sameHost ? outer.withoutLogin : undefined);
  const onShell = options.onShell ?? (sameHost ? outer.onShell : undefined);
  const scope: OperationScope = { target, active: true, ...(withoutLogin !== undefined ? { withoutLogin } : {}), ...(onShell === true ? { onShell } : {}) };
  try {
    return await operationTargets.run(scope, fn);
  } finally {
    scope.active = false;
  }
}

/** Time limit of `docker context inspect` (it reads only local files; the daemon is not asked). */
export const CONTEXT_INSPECT_TIMEOUT_MS = 15_000;

/** A name of a Docker context as the Docker CLI accepts it (never an option). */
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/** The part of BootstrapDocker that the resolver uses. */
export interface ContextReader {
  isInstalled(): boolean;
  /**
   * Whether a Docker CLI runs the calls on a remote engine (BootstrapDocker.canRunRemote: the Docker CLI of Devspaces or
   * of this computer). Without it, only the Docker CLI of this computer (isInstalled).
   */
  canRunRemote?(): boolean;
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /**
   * Whether the docker command is Podman (BootstrapDocker.podmanCli: `docker --version`, kept until the file of the CLI
   * changes, cliFileIdentity): what showed it, or undefined for Docker. Asked only when the current context cannot be
   * read. Without it, the CLI counts as Docker.
   */
  podmanCli?(): Promise<string | undefined>;
}

/** The Docker host of Devspaces (RemoteDockerState.dockerHost): a host of its list, or undefined for the local Docker. */
export interface DockerHostChoice {
  dockerHost(): Promise<string | undefined>;
}

/**
 * The Docker host of Devspaces of `choice`, but none while that host is the own VM of Devspaces (isVmHost) and the VM
 * does not exist (`vmExists`), for example after its removal outside of Devspaces: Devspaces has no Docker host then, so
 * the sidebar shows the setup of the VM, as before its first setup, and a link sets the VM up without a question
 * (docs/requirements.md R-ENG-001). The choice itself stays, so the VM is the Docker host again once it exists. A check
 * that fails counts as an existing VM (logged). The log names each change of the answer once.
 */
export function withoutMissingVm(choice: DockerHostChoice, vmExists: (host: string) => Promise<boolean>, logger: Logger): DockerHostChoice {
  // The VM host whose missing VM the log named last.
  let missingLogged: string | undefined;
  return {
    async dockerHost(): Promise<string | undefined> {
      const host = await choice.dockerHost();
      if (host === undefined || !isVmHost(host)) return host;
      let exists = true;
      try {
        exists = await vmExists(host);
      } catch (error) {
        logger.warn(`Whether the VM of Devspaces exists could not be read, so Devspaces uses ${host}: ${errorMessage(error)}`);
      }
      if (exists) {
        if (missingLogged === host) logger.info(`The VM of Devspaces exists again: Devspaces uses ${host}.`);
        missingLogged = undefined;
        return host;
      }
      if (missingLogged !== host) logger.info(`Devspaces uses its VM (${host}), but the VM is not set up: Devspaces has no Docker host, and the view shows the setup of the VM.`);
      missingLogged = host;
      return undefined;
    },
  };
}

/** Reads the current Docker target, and runs operations with it. */
export class DockerTargets {
  private lastTarget: DockerTarget | undefined;
  private readonly listeners = new Set<(target: DockerTarget) => void>();
  /**
   * The number of the newest read that started, and of the newest one applied (of overlapping reads, the one that
   * started last wins).
   */
  private readsStarted = 0;
  private readApplied = 0;

  constructor(
    private readonly docker: ContextReader,
    private readonly env: NodeJS.ProcessEnv,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
    /** Without it, Devspaces uses the local Docker. */
    private readonly choice?: DockerHostChoice,
    /**
     * Whether Devspaces uses the Docker of this computer: never in the extension (usesComputerDocker), only in the tests
     * of the engine. False: without a host of the list, the target is NO_DOCKER_HOST_TARGET, never the local Docker, and
     * no Docker context of this computer is read.
     */
    private readonly computerDocker = true,
  ) {}

  /** The target of the last read, for synchronous callers (the Docker setup). Undefined before the first read. */
  get last(): DockerTarget | undefined {
    return this.lastTarget;
  }

  /**
   * Reads the current target now: the host of the list of Devspaces that it uses, else its local Docker (readLocal; in
   * the extension NO_DOCKER_HOST_TARGET). Without a Docker CLI for a remote engine (the Docker CLI of Devspaces or of
   * this computer, canRunRemote), the local Docker, so that the Docker setup shows. Never throws.
   */
  async resolve(): Promise<DockerTarget> {
    const read = ++this.readsStarted;
    const host = (this.docker.canRunRemote?.() ?? this.docker.isInstalled()) ? await this.chosenHost() : undefined;
    const target = host === undefined ? await outsideOperation(() => this.readLocal()) : remoteDockerTarget(host);
    // A read that started before a newer one finished (overlapping reads) does not overwrite what that one found.
    if (read < this.readApplied) return target;
    this.readApplied = read;
    this.lastTarget = target;
    for (const listener of [...this.listeners]) {
      try {
        listener(target);
      } catch (error) {
        this.logger.warn(`A listener of the Docker host failed: ${errorMessage(error)}`);
      }
    }
    return target;
  }

  /**
   * The Docker host in the sidebar: `listener` gets every target that `resolve` reads, except one of a read that a
   * newer read overtook. Returns the function that removes it.
   */
  onDidResolve(listener: (target: DockerTarget) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The target of the running operation, or a fresh read outside of one. */
  async current(): Promise<DockerTarget> {
    return operationDockerTarget() ?? this.resolve();
  }

  /** The Docker host of `current()` ('' for the local Docker). */
  async host(): Promise<string> {
    return (await this.current()).host;
  }

  /**
   * Runs `fn` as one operation: the target is read once at its start (unless an operation runs already, whose target
   * `fn` keeps).
   */
  async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (operationDockerTarget()) return fn();
    const target = await this.resolve();
    return runWithDockerTarget(target, fn);
  }

  /**
   * The target of the Docker host `host`, whatever host Devspaces uses now: for a host of the list its Docker over SSH,
   * for '' the local Docker (readLocal). Does not change `last` and tells no listener. Never throws.
   */
  async ofHost(host: string): Promise<DockerTarget> {
    return host === '' ? outsideOperation(() => this.readLocal()) : remoteDockerTarget(host);
  }

  /**
   * The target of the Docker context `name` (for example `default`), whatever context is current. With DOCKER_HOST set
   * in VS Code's environment, DOCKER_HOST decides, as for the local Docker. Undefined where Devspaces does not use the
   * Docker of this computer (`computerDocker`), without a Docker CLI, for a name that is not a context name, or when the
   * context cannot be read (logged). Does not change `last` and tells no listener. Never throws.
   */
  async ofContext(name: string): Promise<DockerTarget | undefined> {
    // Never throws, also not from the check of the CLI or of DOCKER_HOST.
    try {
      if (!this.computerDocker || !CONTEXT_NAME.test(name) || !this.docker.isInstalled()) return undefined;
      const dockerHost = envValue(this.env, 'DOCKER_HOST', this.platform)?.trim();
      if (dockerHost) return dockerTargetOf(dockerHost, undefined);
      const result = await this.docker.run(['context', 'inspect', '--format', '{{json .}}', name], { timeoutMs: CONTEXT_INSPECT_TIMEOUT_MS });
      const parsed = result.exitCode === 0 ? parseContextInspect(result.stdout) : undefined;
      if (parsed) return dockerTargetOf(parsed.endpoint, parsed.name);
      this.logger.warn(`The Docker context ${name} could not be read: ${(result.stderr || result.stdout).trim()}`);
    } catch (error) {
      this.logger.warn(`The Docker context ${name} could not be read: ${errorMessage(error)}`);
    }
    return undefined;
  }

  /** The host of the list that Devspaces uses, or undefined for the local Docker (also when it cannot be read, logged). */
  private async chosenHost(): Promise<string | undefined> {
    try {
      return await this.choice?.dockerHost();
    } catch (error) {
      this.logger.warn(`The Docker host of Devspaces could not be read, so it uses the local Docker: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The local Docker of Devspaces: NO_DOCKER_HOST_TARGET where Devspaces does not use the Docker of this computer
   * (`computerDocker`), else DOCKER_HOST of VS Code's environment if set, else the current Docker context (which
   * DOCKER_CONTEXT may name); one that reaches a host over SSH is not supported (isDockerContextHostTarget). Without a
   * Docker CLI, the local Docker. When the context cannot be read: DOCKER_HOST when it is set, else podmanDockerTarget
   * for a docker command that is Podman, else UNREADABLE_DOCKER_TARGET (logged). Never throws. Its callers run it
   * outside of any operation: inside one on a remote host, its Docker calls would get DOCKER_HOST of that host.
   */
  private async readLocal(): Promise<DockerTarget> {
    if (!this.computerDocker) return NO_DOCKER_HOST_TARGET;
    if (!this.docker.isInstalled()) return LOCAL_DOCKER_TARGET;
    const dockerHost = envValue(this.env, 'DOCKER_HOST', this.platform)?.trim();
    let detail: string;
    try {
      // With DOCKER_HOST set, the CLI inspects the context `default`, whose endpoint is DOCKER_HOST.
      const result = await this.docker.run(['context', 'inspect', '--format', '{{json .}}'], { timeoutMs: CONTEXT_INSPECT_TIMEOUT_MS });
      const parsed = result.exitCode === 0 ? parseContextInspect(result.stdout) : undefined;
      if (parsed) return dockerTargetOf(dockerHost ? dockerHost : parsed.endpoint, dockerHost ? undefined : parsed.name);
      detail = (result.stderr || result.stdout).trim();
    } catch (error) {
      detail = errorMessage(error);
    }
    return this.unreadable(dockerHost, detail);
  }

  /**
   * The target when the current context cannot be read: DOCKER_HOST decides when it is set. Else the docker command
   * may be Podman (the package podman-docker: Podman 5 prints an empty list `[]` for `docker context inspect`, older
   * versions do not know the command), which the check of the CLI shows; a check that fails counts as Docker. Else
   * nothing. Logged.
   */
  private async unreadable(dockerHost: string | undefined, detail: string): Promise<DockerTarget> {
    if (dockerHost) {
      this.logger.warn(`The current Docker context could not be read. DOCKER_HOST is used: ${detail}`);
      return dockerTargetOf(dockerHost, undefined);
    }
    const podman = await this.podmanCli();
    if (podman !== undefined) {
      this.logger.warn(`The current Docker context could not be read, and the docker command uses Podman, which Devspaces does not support. ${podman}`);
      return podmanDockerTarget(podman);
    }
    this.logger.warn(`The current Docker context could not be read. Devspaces does nothing with Docker until it can be read: ${detail}`);
    return UNREADABLE_DOCKER_TARGET;
  }

  /** ContextReader.podmanCli; undefined (Docker) without it or when it fails (logged). Never throws. */
  private async podmanCli(): Promise<string | undefined> {
    try {
      return await this.docker.podmanCli?.();
    } catch (error) {
      this.logger.warn(`The docker command could not be checked for Podman, so Docker is assumed: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
