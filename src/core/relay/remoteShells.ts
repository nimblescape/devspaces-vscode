// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The shells before the relay of this window (docs/architecture.md "The shell before the relay"): at most one per remote
// host (an SSH host, or the WSL distribution of Devspaces), opened by the first check or Docker call before a connection
// of the relay to the host, used by the calls after it, and taken over by the next connection of the relay to the host
// (takeOver). No `vscode`.
import { WSL_START_ATTEMPTS, hostAccessOf, isVmHost, transportProgramOf, wslStartTimedOut } from '../docker/dockerHost';
import { errorMessage } from '../errors';
import { abortError, isAbortError, untilAborted, type Logger, type RunOptions, type RunResult, type StartedByteProcess } from '../ports';
import { currentSshPromptFlow, type SshLoginPrompts } from '../sshAskpass';
import { RemoteShell, RemoteShellError, ShellGoneError, LIMA_SHELL_LOGIN_TIMEOUT_MS, WSL_SHELL_LOGIN_TIMEOUT_MS, dockerShellCommand } from './remoteShell';

/** A login that started: its process, and the questions it may ask in VS Code (a login of a flow of the user). */
export interface RemoteShellStart {
  process: StartedByteProcess;
  prompts?: SshLoginPrompts;
  /**
   * Runs once the shell is open (the key offer of SshKeyOffer, which may ask the user and run a command on it). The
   * callers get the shell at once, and its commands run in order; the relay takes it over only after this step, and it
   * is not closed for a time without use meanwhile. A failure is logged.
   */
  afterLogin?: (shell: RemoteShell) => Promise<void>;
}

export interface RemoteShellsOptions {
  logger: Logger;
  /**
   * Starts the login `ssh … sh -s` to `host` (sshHostTransport), or `wsl.exe … sh -s` for a WSL distribution
   * (wslHostTransport); undefined when the host has no transport.
   */
  start(host: string): RemoteShellStart | undefined;
  /** Only for the tests (all hosts). Default: SHELL_LOGIN_TIMEOUT_MS, WSL_SHELL_LOGIN_TIMEOUT_MS for a WSL distribution, and LIMA_SHELL_LOGIN_TIMEOUT_MS for the Lima VM. */
  loginTimeoutMs?: number;
  idleCloseMs?: number;
}

/** A shell of `RemoteShells`: open, or still logging in on `process`. */
interface Entry {
  process: StartedByteProcess;
  /** The flow of the user that started this login (currentSshPromptFlow), or none (the background). */
  flow?: object;
  shell?: RemoteShell;
  opening?: Promise<RemoteShell>;
  /** The step after the login (RemoteShellStart.afterLogin) while it runs; takeOver waits for it. */
  afterLogin?: Promise<void>;
}

/** The shells before the relay of this window, by the Docker host (DockerTarget.host). */
export class RemoteShells {
  private readonly entries = new Map<string, Entry>();
  /** The hosts whose shell `keep` holds back from the relay, with the number of holds. */
  private readonly kept = new Map<string, number>();
  private disposed = false;

  constructor(private readonly options: RemoteShellsOptions) {}

  /**
   * The open shell to `host`, or a new one (one login of its transport, RemoteShell.open), which callers at the same time share.
   * Undefined when the host has no transport, and after `dispose`. Rejects with RemoteShellError when the login failed,
   * and with an AbortError when `signal` aborts (the login goes on for the others). A flow of the user whose login may
   * ask (currentSshPromptFlow) that finds a login of the background or of another flow in progress waits for it, and
   * logs in anew when it failed: a login without questions fails for a host that needs a password or an unknown host
   * key, and the Cancel of the other flow ends the questions of its login. After the time limit of that login it does
   * not: a login without questions fails at once instead of waiting, so the host did not answer in time. `fresh` (the
   * test of a host): the open shell to the host ends at once (a command on it ends with it), and a new login starts; a
   * login in progress counts as new. A login to a WSL distribution has a longer time limit (WSL_SHELL_LOGIN_TIMEOUT_MS),
   * and starts again when WSL ran out of time to start the distribution (wslStartTimedOut), at most WSL_START_ATTEMPTS
   * times in all. A login to the Lima VM has a longer time limit too (LIMA_SHELL_LOGIN_TIMEOUT_MS): it starts the VM.
   */
  open(host: string, signal?: AbortSignal, options: { fresh?: boolean } = {}): Promise<RemoteShell | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const current = this.entries.get(host);
    if (current?.shell?.isOpen) {
      if (options.fresh !== true) return Promise.resolve(current.shell);
      // The step after its login (the key offer) ends first: it may run a command on the shell.
      if (current.afterLogin !== undefined) return untilAborted(current.afterLogin, signal).then(() => this.open(host, signal, options));
      // Its end forgets its entry (onEnd).
      current.shell.close();
    }
    if (current?.opening) {
      const flow = currentSshPromptFlow();
      if (flow === undefined || current.flow === flow) return untilAborted(current.opening, signal);
      return untilAborted(
        current.opening.catch((error: unknown) => {
          if (!(error instanceof RemoteShellError) || error.timedOut || signal?.aborted) throw error;
          return this.open(host, signal);
        }),
        signal,
      );
    }
    const started = this.options.start(host);
    if (started === undefined) return Promise.resolve(undefined);
    // The start of the last login (a new one after WSL ran out of time to start the distribution).
    let latest = started;
    const entry: Entry = { process: started.process, flow: currentSshPromptFlow() };
    const forget = () => {
      if (this.entries.get(host) === entry) this.entries.delete(host);
    };
    const { logger, idleCloseMs } = this.options;
    const access = hostAccessOf(host);
    const distribution = access?.kind === 'wsl' ? access.distribution : undefined;
    const loginTimeoutMs =
      this.options.loginTimeoutMs ?? (distribution !== undefined ? WSL_SHELL_LOGIN_TIMEOUT_MS : access?.kind === 'lima' ? LIMA_SHELL_LOGIN_TIMEOUT_MS : undefined);
    const login = async (): Promise<RemoteShell> => {
      for (let attempt = 1; ; attempt++) {
        try {
          // The end of a login that failed does not forget the entry: a new login may follow, and the failure forgets it.
          const onEnd = (): void => {
            if (entry.shell !== undefined) forget();
          };
          return await RemoteShell.open(latest.process, { logger, name: host, program: transportProgramOf(host), loginTimeoutMs, idleCloseMs, onEnd, prompts: latest.prompts });
        } catch (error) {
          if (distribution === undefined || attempt >= WSL_START_ATTEMPTS || this.disposed || !(error instanceof RemoteShellError) || error.timedOut || !wslStartTimedOut(error.detail)) throw error;
          const next = this.options.start(host);
          if (next === undefined) throw error;
          logger.info(`WSL ran out of time to start the distribution ${distribution} (attempt ${attempt} of ${WSL_START_ATTEMPTS}), so Devspaces starts it again: ${error.detail}`);
          latest = next;
          entry.process = next.process;
        }
      }
    };
    entry.opening = login().then(
      (shell) => {
        entry.shell = shell;
        entry.opening = undefined;
        if (this.disposed) {
          shell.killNow();
          return shell;
        }
        logger.info(`The shell on ${host} is open: one login for the checks before the relay.`);
        const { afterLogin } = latest;
        if (afterLogin !== undefined) {
          const step: Promise<void> = shell
            .keepOpenDuring(() => afterLogin(shell))
            .catch((error: unknown) => logger.warn(`The step after the login on ${host} failed: ${errorMessage(error)}`))
            .finally(() => {
              if (entry.afterLogin === step) entry.afterLogin = undefined;
            });
          entry.afterLogin = step;
        }
        return shell;
      },
      (error: unknown) => {
        forget();
        throw error;
      },
    );
    this.entries.set(host, entry);
    return untilAborted(entry.opening, signal);
  }

  /**
   * The login of the shell to `host` (`open`, also with `fresh`), for the SSH check (RemoteShellAccess.login): undefined
   * when the host has no transport; a failure with the error output of `ssh` or `wsl.exe`. Rejects only with an
   * AbortError.
   */
  async login(
    host: string,
    signal?: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; detail: string; timedOut: boolean } | undefined> {
    try {
      return (await this.open(host, signal, options)) === undefined ? undefined : { ok: true };
    } catch (error) {
      if (error instanceof RemoteShellError) return { ok: false, detail: error.detail, timedOut: error.timedOut };
      throw error;
    }
  }

  /**
   * Runs `command` (one line for the shell) on the shell of `host` (`open`): its result as ProcessRunner.run gives it
   * (RemoteShell.run). A shell that was closed or taken over before the command started is replaced by a new one, once,
   * but not for a call whose `options.signal` aborted meanwhile. Undefined when the host has no transport, and after
   * `dispose`. A failed login gives the result of `ssh` (or `wsl.exe`): exit code 255 (none after its time limit) and
   * its error output. Rejects with an AbortError when `options.signal` aborts. With `login: false`, only on a shell
   * that is open or logging in, never a new login: undefined also when there is none, or when it ended before the
   * command started (the utilization page, which must not start the VM of Devspaces with a login, R-VM-004, reads the
   * state of the VM before it lets `run` log in). With `relogin: false`, the shell that replaces a closed one is only a
   * shell that is open or logging in, as with `login: false` (the page logs in to the VM of Devspaces only right after
   * its check of the state of the VM, and a stop of the VM closes the shell).
   */
  async run(
    host: string,
    command: string,
    options: Pick<RunOptions, 'timeoutMs' | 'signal'> & { input?: string; login?: boolean; relogin?: boolean } = {},
  ): Promise<RunResult | undefined> {
    for (let attempt = 0; ; attempt++) {
      let shell: RemoteShell | undefined;
      try {
        const login = options.login !== false && (attempt === 0 || options.relogin !== false);
        shell = login ? await this.open(host, options.signal) : await this.current(host, options.signal);
      } catch (error) {
        if (!(error instanceof RemoteShellError)) throw error;
        return { exitCode: error.timedOut ? null : 255, stdout: '', stderr: error.detail, timedOut: error.timedOut };
      }
      if (shell === undefined) return undefined;
      try {
        return await shell.run(command, options);
      } catch (error) {
        if (!(error instanceof ShellGoneError) || attempt > 0 || isAbortError(error)) throw error;
        // A call that was ended (its signal aborted) while it waited on the shell logs in no more.
        if (options.signal?.aborted) throw abortError();
      }
    }
  }

  /**
   * `docker <args>` on the shell of `host` (`run` with dockerShellCommand), with the Docker CLI of that computer.
   * Undefined also for a word that the line of the shell cannot carry.
   */
  docker(host: string, args: readonly string[], options: Pick<RunOptions, 'timeoutMs' | 'signal'> = {}): Promise<RunResult | undefined> {
    const command = dockerShellCommand(args);
    return command === undefined ? Promise.resolve(undefined) : this.run(host, command, options);
  }

  /** The shell to `host` that is open or logging in, without a new login: undefined when there is none. */
  private current(host: string, signal?: AbortSignal): Promise<RemoteShell | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    const entry = this.entries.get(host);
    if (entry?.shell?.isOpen) return Promise.resolve(entry.shell);
    if (entry?.opening) return untilAborted(entry.opening, signal);
    return Promise.resolve(undefined);
  }

  /**
   * Holds the shell to `host` back from the relay until the returned function runs (the utilization page of the host
   * samples on it): takeOver gives nothing to a connection of the relay that opens in a flow of the user, which logs in
   * itself and may ask, and nothing on the VM of Devspaces, whose login asks nothing. Without the hold, the next sample
   * after a takeover would need a new login outside of a flow of the user, which cannot ask for a password. A
   * connection of the relay in the background cannot ask either: it still takes the shell, because the window needs it
   * more than the page, which logs in anew (or shows that it cannot).
   */
  keep(host: string): () => void {
    this.kept.set(host, (this.kept.get(host) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.kept.get(host) ?? 1) - 1;
      if (count > 0) this.kept.set(host, count);
      else this.kept.delete(host);
    };
  }

  /**
   * The process of the shell to `host` for a connection of the relay (RemoteShell.takeOver), also of a login that is
   * in progress, after the step after its login; undefined when there is none or it failed. The shell is no longer one
   * of this window then. On an SSH host, the takeover waits for the commands before it, because a new login may ask
   * for the password again. A shell of the VM of Devspaces with a command on it (RemoteShell.busy, for example a long
   * removal of the view Docker Hosts) stays with its commands, and the relay logs in itself: a login to the VM asks
   * nothing, and the open of a devspace does not wait for that command. A shell that `keep` holds stays too, except
   * for a connection of the relay in the background on an SSH host.
   */
  async takeOver(host: string): Promise<StartedByteProcess | undefined> {
    const inFlow = currentSshPromptFlow() !== undefined;
    const held = () => this.kept.has(host) && (inFlow || isVmHost(host));
    const entry = this.entries.get(host);
    if (entry === undefined) return undefined;
    let shell: RemoteShell | undefined;
    try {
      shell = entry.shell ?? (await entry.opening);
    } catch {
      return undefined;
    }
    await entry.afterLogin;
    if ((shell?.busy === true && isVmHost(host)) || held()) return undefined;
    // A hold that started while the takeover waited for the commands before it counts too.
    return shell?.takeOver(() => !held());
  }

  /**
   * Stops the shell to `host` at once, also a login in progress (a stop or a removal of the VM of Devspaces, R-VM-010):
   * a command on it ends with it (RemoteShell.run), and the next call logs in anew. A shell that the relay took over is
   * no longer one of this window and stays.
   */
  close(host: string): void {
    const entry = this.entries.get(host);
    if (entry === undefined) return;
    this.entries.delete(host);
    if (entry.shell) entry.shell.killNow();
    else if (entry.process.killNow) entry.process.killNow();
    else entry.process.kill();
  }

  /** Stops every shell at once (the window closes), also a login in progress. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.shell) entry.shell.killNow();
      else if (entry.process.killNow) entry.process.killNow();
      else entry.process.kill();
    }
    this.entries.clear();
  }
}
