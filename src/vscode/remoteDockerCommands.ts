// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Devspaces: Use a Remote Docker Host…" and the choice of the first row of the view. Devspaces never uses the Docker
// of this computer (docs/requirements.md R-ENG-001): its Docker host is its own VM, or a host of its own list of SSH
// hosts (RemoteDockerState, docs/architecture.md "Remote Docker hosts"). "Use a Remote Docker Host…" tests a host with
// one SSH login, which may ask for a password or an unknown host key in VS Code (sshLoginPrompts.ts), and makes it the
// Docker host of Devspaces (it joins the list). Nothing else is written: no Docker context, no setting, no DOCKER_HOST,
// no setting of the Dev Containers extension, so the docker command in the terminals of the user keeps its target. One
// Docker host at a time, for every window of Devspaces on this computer. A computer without a Docker CLI gets the
// Docker CLI of Devspaces for the remote host first (ensureRemoteCli), so no Docker needs to be installed on it. The
// own VM of Devspaces is offered as a host when it exists: on Windows its WSL distribution (WSL_HOST, wslState), which
// Devspaces reaches with `wsl.exe`, without SSH; on macOS and Linux its Lima VM (LIMA_HOST, limaState), which Devspaces
// reaches over the SSH of Lima, without a login of the user. While the own VM does not exist, the choice offers its
// setup instead, so that every platform can go back to it from a remote host.
import * as vscode from 'vscode';
import {
  LIMA_HOST,
  WSL_DISTRIBUTION,
  WSL_HOST,
  describeDockerHost,
  hostEndpoint,
  parseSshAddress,
  type SshAddressProblem,
} from '../core/docker/dockerHost';
import type { DockerTargets } from '../core/docker/dockerTargets';
import {
  recordRootlessSocket,
  sshHostsOfContexts,
  testRemoteDockerHost,
  type RemoteDockerCli,
  type RemoteShellAccess,
  type SshLoginCache,
} from '../core/docker/remoteDocker';
import { errorMessage, isUserFacingError } from '../core/errors';
import { Actions, Messages, dockerHostReason } from '../core/messages';
import { isAbortError, type Logger, type ProcessRunner } from '../core/ports';
import type { SshHostEntry } from '../core/sshConfig';
import type { RemoteDockerState } from '../core/storage/remoteDockerState';
import { Commands } from './commands';
import { showErrorMessage, showInformationMessage } from './notifications';
import { withNotificationProgress } from './progress';

/** User-visible texts of the remote Docker host (plain language). No `vscode` in them. */
export const RemoteDockerTexts = {
  pickTitle: 'Use a Remote Docker Host',
  pickPlaceholder: 'Choose a host, or enter an SSH address',
  /** The groups of the hosts in the choice. */
  listGroup: 'Hosts of Devspaces',
  sshConfigGroup: 'SSH config',
  contextGroup: 'Docker contexts',
  wslGroup: 'WSL',
  /** The description of the WSL distribution of Devspaces in the choice. */
  wslDistribution: (name: string) => `WSL distribution ${name} of Devspaces`,
  /** The group and the description of the Lima VM of Devspaces in the choice (macOS and Linux). */
  limaGroup: 'Lima',
  limaVm: 'the VM of Devspaces (Lima)',
  /** The entry of the choice on macOS and Linux while the VM of Devspaces does not exist: its setup (devspaces.setUpLimaVm). */
  setUpVm: 'Set Up Docker for Devspaces in Its VM…',
  setUpVmDetail: 'creates the VM of Devspaces on this computer and uses it',
  /** The entry of the choice on Windows while the WSL distribution of Devspaces does not exist: its setup (devspaces.setUpWslDistribution). */
  setUpWsl: 'Set Up Docker for Devspaces in WSL…',
  setUpWslDetail: 'creates the WSL distribution of Devspaces and uses it',
  enterAddress: 'Enter an SSH address…',
  enterAddressDetail: 'user@host or user@host:port',
  addressPrompt: 'The SSH address of the computer with Docker, for example me@build-box or me@192.0.2.10:2222',
  addressProblem: (problem: SshAddressProblem): string => {
    switch (problem) {
      case 'empty':
        return 'Enter an address such as me@build-box.';
      case 'spaces':
        return 'The address must not contain spaces.';
      case 'option':
        return 'The address must not start with "-".';
      case 'path':
        return 'Enter only user@host[:port], without a path or a query.';
      case 'user':
        return 'The user name may contain letters, digits, ".", "_" and "-", and must not start with "-".';
      case 'host':
        return 'The host must be a name such as build-box.example.com or an IPv4 address.';
      case 'ipv6':
        return 'Write an IPv6 address in brackets, for example [2001:db8::1]:22.';
      case 'port':
        return 'The port must be a number from 1 to 65535.';
    }
  },
  /** The description of a host of a Docker context of the user in the choice. */
  dockerContext: (name: string) => `Docker context ${name}`,
  testing: (host: string) =>
    host === WSL_HOST
      ? 'Starting and testing the WSL distribution of Devspaces. Its first start after a restart of Windows can take some minutes…'
      : host === LIMA_HOST
        ? 'Starting and testing the VM of Devspaces…'
        : `Testing the connection to ${host}…`,
  nowRemote: (host: string, rootless: boolean) =>
    `Devspaces now uses Docker on ${host}.${rootless ? ' Its Docker engine runs rootless: ports below 1024 cannot be published there.' : ''} The docker command in your terminals keeps its Docker context.`,
  /** The title of the choice of the Docker host while Devspaces has none. */
  noHost: 'none',
  alreadyHost: (host: string) => `Devspaces already uses ${host}.`,
  switchFailed: 'The Docker host of Devspaces could not be changed.',
  /** The title of the choice of the Docker host (the first row of the view). */
  chooseTitle: (host: string) => `Docker host: ${host}`,
  current: 'current',
  /** Neither the Docker CLI of this computer nor one of Devspaces (Docker publishes none for this computer). */
  cliMissing: 'Docker publishes no Docker CLI that Devspaces can download for this computer, so a remote Docker host needs the Docker CLI of Docker Desktop here. Install Docker first.',
  /** The entry of the choice that removes a host from the list, and its own choice. */
  removeHost: 'Remove a Host from the List…',
  removeTitle: 'Remove a Host from the List',
  removePlaceholder: 'Choose the host that Devspaces forgets',
  removed: (host: string, devspaces: number, wasCurrent: boolean) =>
    `${host} is no longer in the list of Devspaces.${
      devspaces > 0 ? ` ${devspaces === 1 ? 'Its devspace stays' : `Its ${devspaces} devspaces stay`} on that computer: add ${host} again to show ${devspaces === 1 ? 'it' : 'them'} in the sidebar.` : ''
    }${wasCurrent ? ' Devspaces has no Docker host now: set up Docker for Devspaces in the Devspaces view, or choose another host.' : ''}`,
} as const;

export interface RemoteDockerDeps {
  docker: RemoteDockerCli;
  runner: ProcessRunner;
  targets: Pick<DockerTargets, 'resolve' | 'last'>;
  state: RemoteDockerState;
  logger: Logger;
  showLog: () => void;
  /** The concrete hosts of the user's SSH config (parseSshConfig). */
  sshHosts: () => SshHostEntry[];
  /** The path of `ssh` on this computer (findExecutable), or undefined. */
  sshPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /** The successes of the SSH check, shared with the operations. */
  sshLogins?: SshLoginCache;
  /**
   * The shells before the relay: the test of a host is one login, which may ask for a password or an unknown host key
   * in VS Code (sshAskpass.ts), and the read of the socket of a rootless engine runs on it too.
   */
  shells?: RemoteShellAccess;
  /** The key of Devspaces for `host` when that host has it (SshCheckDeps.identityFor). */
  identityFor?(host: string): string | undefined;
  /** The environment of a Docker call with `ssh://<host>` with that key (SshCheckDeps.sshEnv). */
  sshEnv?(host: string, env: NodeJS.ProcessEnv): void;
  /**
   * The names of the WSL distributions of this Windows user (`wsl.exe --list --quiet`); none without WSL. Only on
   * Windows: without it, neither the WSL distribution of Devspaces nor its setup is offered.
   */
  wslDistributions?: () => Promise<string[]>;
  /** Whether the Lima VM of Devspaces exists. Only on macOS and Linux: without it, neither the Lima VM nor its setup is offered. */
  limaVmExists?: () => Promise<boolean>;
  /** The number of devspaces of this computer on `host` (its registry), for the message of a removed host. */
  devspaceCount?: (host: string) => Promise<number>;
  /** After a change of the Docker host of Devspaces: the sidebar shows the devspaces of the new host. */
  onDidSwitch: () => Promise<void>;
  /**
   * Downloads the Docker CLI of Devspaces with a progress notification (installOwnDockerCliWithProgress) for a computer
   * without a Docker CLI: its path, or undefined when the download failed (the message says so) or was cancelled.
   * Undefined where Docker publishes no Docker CLI that runs on this computer.
   */
  installOwnCli?: () => Promise<string | undefined>;
}

interface HostItem extends vscode.QuickPickItem {
  host?: string;
  /** The entry "Remove a Host from the List…". */
  remove?: boolean;
  /** The command of the entry "Set Up Docker for Devspaces in Its VM…" or "… in WSL…", while the own VM does not exist. */
  setUp?: string;
}

/** pickHost: the user chose to remove a host from the list. */
const REMOVE_CHOICE = Symbol('remove a host');
/** pickHost: the user chose the setup of the own VM of Devspaces, with this command. */
interface SetUpChoice {
  setUp: string;
}

export class RemoteDockerCommands {
  constructor(private readonly deps: RemoteDockerDeps) {}

  /**
   * "Use a Remote Docker Host…": pick, test, use. On a computer without a Docker CLI, the Docker CLI of Devspaces is
   * downloaded after the pick (ensureRemoteCli). Never throws.
   */
  async useRemoteHost(): Promise<void> {
    await this.pickAndUse(false);
  }

  /**
   * The first row of the sidebar, which names the Docker host (the title bar has no icons for it): the same choice as
   * "Use a Remote Docker Host…", with the current host in the title. Never throws.
   */
  async chooseDockerHost(): Promise<void> {
    await this.pickAndUse(true);
  }

  /** The choice of both commands; `titled`: the title names the current Docker host. Never throws. */
  private async pickAndUse(titled: boolean): Promise<void> {
    try {
      const current = await this.deps.state.dockerHost();
      const title = titled ? RemoteDockerTexts.chooseTitle(current === undefined ? RemoteDockerTexts.noHost : describeDockerHost(current)) : undefined;
      const picked = await this.pickHost({ title, currentHost: current });
      if (picked === undefined) return;
      if (picked === REMOVE_CHOICE) {
        await this.removeHost();
        return;
      }
      if (typeof picked === 'object') {
        await this.setUpVm(picked.setUp);
        return;
      }
      // The host of the list without a Docker CLI for it (DockerTargets.resolve gave no host): as a new choice.
      if (picked === current && this.remoteCliReady()) {
        this.inform(RemoteDockerTexts.alreadyHost(picked));
        return;
      }
      if (!(await this.ensureRemoteCli())) return;
      await this.switchToRemote(picked);
    } catch (error) {
      this.showFailure(error);
    }
  }

  /**
   * The setup of the own VM of Devspaces (`command`: LimaSetupCommands or WslSetupCommands), which makes the VM the
   * Docker host of Devspaces.
   */
  private async setUpVm(command: string): Promise<void> {
    this.deps.logger.info(`The choice of the Docker host starts the setup of the own VM of Devspaces (${command}).`);
    await vscode.commands.executeCommand(command);
  }

  /**
   * Devspaces uses `host` after its test, without a choice (the WSL distribution of Devspaces after its setup): the
   * Docker CLI of Devspaces first when this computer has none (ensureRemoteCli). True when Devspaces uses it afterwards;
   * a failure is shown. Never throws.
   */
  async useHost(host: string): Promise<boolean> {
    try {
      if (!(await this.ensureRemoteCli())) return false;
      return await this.switchToRemote(host);
    } catch (error) {
      this.showFailure(error);
      return false;
    }
  }

  /**
   * `host` leaves the list of Devspaces without a choice (the removal of the WSL distribution of Devspaces); when
   * Devspaces used it, Devspaces has no Docker host afterwards, and the sidebar shows the Docker setup. Returns whether
   * Devspaces used it. Throws only when the list cannot be changed: the steps after the change never throw.
   */
  async forgetHost(host: string): Promise<boolean> {
    const { removed, wasDockerHost } = await this.deps.state.removeHost(host);
    if (removed) this.deps.logger.info(`${host} was removed from the list of Devspaces.`);
    if (!wasDockerHost) return false;
    await this.deps.targets.resolve();
    this.deps.logger.info('Devspaces has no Docker host now; the sidebar shows the Docker setup.');
    await this.afterSwitch();
    return true;
  }

  /** Test, rootless socket, use. True when Devspaces uses `host` afterwards. */
  private async switchToRemote(host: string): Promise<boolean> {
    this.deps.logger.info(`Devspaces tests the Docker host ${host}.`);
    const check = await withNotificationProgress(
      { title: RemoteDockerTexts.testing(host), cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          const result = await testRemoteDockerHost(
            this.deps.docker,
            host,
            {
              runner: this.deps.runner,
              sshPath: this.deps.sshPath(),
              env: this.deps.env,
              sshLogins: this.deps.sshLogins,
              shells: this.deps.shells,
              identityFor: this.deps.identityFor,
              sshEnv: this.deps.sshEnv,
            },
            { signal: controller.signal },
          );
          // A rootless engine: its socket is read once (ssh, without questions) and recorded with the host.
          if (result.ok) {
            await recordRootlessSocket(host, result.rootless, {
              runner: this.deps.runner,
              state: this.deps.state,
              logger: this.deps.logger,
              sshPath: this.deps.sshPath(),
              env: this.deps.env,
              shells: this.deps.shells,
              identityFor: this.deps.identityFor,
            }, controller.signal);
          }
          return result;
        } finally {
          subscription.dispose();
        }
      },
    );
    if (!check.ok) {
      this.deps.logger.warn(`The Docker host ${host} cannot be reached: ${check.detail}`);
      // A damaged disk of the WSL distribution of Devspaces: its button removes the distribution and sets it up again.
      const reset = check.problem === 'wslDiskCorrupt' && host === WSL_HOST;
      this.showError(Messages.dockerHostUnreachable(host, dockerHostReason(check.problem, host)), reset ? 'resetWsl' : undefined);
      return false;
    }
    this.deps.logger.info(`The Docker host ${host} answers: Docker engine ${check.version}${check.rootless ? ' (rootless)' : ''}.`);
    await this.deps.state.setDockerHost(host);
    this.deps.logger.info(`Devspaces uses ${host} (${hostEndpoint(host)}). No Docker context was changed.`);
    await this.deps.targets.resolve();
    this.inform(RemoteDockerTexts.nowRemote(host, check.rootless));
    await this.afterSwitch();
    return true;
  }

  /**
   * "Remove a Host from the List…": the chosen host leaves the list; when Devspaces uses it, Devspaces has no Docker host
   * afterwards. Its devspaces stay on that computer, and nothing there is changed.
   */
  private async removeHost(): Promise<void> {
    const { remoteHosts: hosts = [], dockerHost: current } = await this.deps.state.read();
    if (hosts.length === 0) return;
    const picked = await vscode.window.showQuickPick(
      hosts.map((host) => (host === current ? { label: host, description: RemoteDockerTexts.current, host } : { label: host, host })),
      { title: RemoteDockerTexts.removeTitle, placeHolder: RemoteDockerTexts.removePlaceholder },
    );
    if (picked === undefined) return;
    // What the file holds now counts, not what was read before the choice (another window may have changed it).
    const { removed, wasDockerHost } = await this.deps.state.removeHost(picked.host);
    if (!removed) {
      this.deps.logger.info(`${picked.host} is not in the list of Devspaces anymore.`);
      return;
    }
    const count = await (this.deps.devspaceCount?.(picked.host) ?? Promise.resolve(0)).catch((error: unknown) => {
      this.deps.logger.warn(`The devspaces on ${picked.host} could not be counted: ${errorMessage(error)}`);
      return 0;
    });
    this.deps.logger.info(`${picked.host} was removed from the list of Devspaces (${count} devspaces on it).`);
    this.inform(RemoteDockerTexts.removed(picked.host, count, wasDockerHost));
    if (!wasDockerHost) return;
    await this.deps.targets.resolve();
    await this.afterSwitch();
  }

  /**
   * A Docker CLI for the calls on a remote host: the Docker CLI of Devspaces or of this computer (canRunRemote). Without
   * either, the Docker CLI of Devspaces is downloaded now (installOwnCli); where Docker publishes none for this
   * computer, the message says to install Docker. True when there is one afterwards.
   */
  private async ensureRemoteCli(): Promise<boolean> {
    const { installOwnCli, logger } = this.deps;
    if (this.remoteCliReady()) return true;
    if (installOwnCli === undefined) {
      logger.warn('This computer has no Docker CLI, and Docker publishes none that Devspaces can download for it; no remote Docker host is set.');
      this.showError(RemoteDockerTexts.cliMissing);
      return false;
    }
    logger.info('This computer has no Docker CLI, so Devspaces downloads its own Docker CLI for the remote Docker host.');
    return (await installOwnCli()) !== undefined && this.remoteCliReady();
  }

  /** Whether a Docker CLI runs the calls on a remote host: the one of Devspaces or of this computer (canRunRemote). */
  private remoteCliReady(): boolean {
    const { docker } = this.deps;
    return docker.canRunRemote?.() ?? docker.isInstalled();
  }

  /**
   * A host or a typed SSH address: the hosts of the list of Devspaces, then the other hosts of the SSH config, then the
   * SSH hosts of the Docker contexts of the user, then the own VM of Devspaces when it exists and is not in the list
   * (each host once); `currentHost` is marked. "Remove a Host from the List…" when the list has a host. While the own VM
   * of Devspaces does not exist, its group has its setup instead (SetUpChoice): on Windows the WSL group, while the WSL
   * distribution of Devspaces is not registered, and on macOS and Linux the Lima group, while the VM does not exist.
   */
  private async pickHost(options: { title?: string; currentHost?: string }): Promise<string | typeof REMOVE_CHOICE | SetUpChoice | undefined> {
    let entries: SshHostEntry[] = [];
    try {
      entries = this.deps.sshHosts();
    } catch (error) {
      this.deps.logger.warn(`The SSH config could not be read: ${errorMessage(error)}`);
    }
    const [listed, contextHosts, wsl, lima] = await Promise.all([this.deps.state.remoteHosts(), this.contextHosts(), this.wslState(), this.limaState()]);
    const wslHosts = wsl === 'exists' ? [WSL_HOST] : [];
    const limaHosts = lima === 'exists' ? [LIMA_HOST] : [];
    const shown = new Set<string>();
    const item = (host: string, description: string | undefined): HostItem => {
      shown.add(host);
      if (host !== options.currentHost) return { label: host, description, host };
      return { label: `$(check) ${host}`, description: description ? `${description} · ${RemoteDockerTexts.current}` : RemoteDockerTexts.current, host };
    };
    const describe = (host: string): string | undefined => {
      if (host === WSL_HOST) return RemoteDockerTexts.wslDistribution(WSL_DISTRIBUTION);
      if (host === LIMA_HOST) return RemoteDockerTexts.limaVm;
      const entry = entries.find((candidate) => candidate.alias === host);
      return entry === undefined ? undefined : describeEntry(entry);
    };
    const groups: Array<{ label: string; items: HostItem[] }> = [
      { label: RemoteDockerTexts.listGroup, items: listed.map((host) => item(host, describe(host))) },
      { label: RemoteDockerTexts.sshConfigGroup, items: entries.filter((entry) => !shown.has(entry.alias)).map((entry) => item(entry.alias, describeEntry(entry))) },
      {
        label: RemoteDockerTexts.contextGroup,
        items: contextHosts.filter((entry) => !shown.has(entry.host)).map((entry) => item(entry.host, RemoteDockerTexts.dockerContext(entry.context))),
      },
      {
        label: RemoteDockerTexts.wslGroup,
        items:
          wsl === 'missing'
            ? [{ label: `$(add) ${RemoteDockerTexts.setUpWsl}`, description: RemoteDockerTexts.setUpWslDetail, setUp: Commands.setUpWslDistribution }]
            : wslHosts.filter((host) => !shown.has(host)).map((host) => item(host, describe(host))),
      },
      {
        label: RemoteDockerTexts.limaGroup,
        items:
          lima === 'missing'
            ? [{ label: `$(add) ${RemoteDockerTexts.setUpVm}`, description: RemoteDockerTexts.setUpVmDetail, setUp: Commands.setUpLimaVm }]
            : limaHosts.filter((host) => !shown.has(host)).map((host) => item(host, describe(host))),
      },
    ];
    const items: HostItem[] = [];
    for (const group of groups) {
      if (group.items.length === 0) continue;
      items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator }, ...group.items);
    }
    if (items.length > 0) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: RemoteDockerTexts.enterAddress, description: RemoteDockerTexts.enterAddressDetail });
    if (listed.length > 0) items.push({ label: RemoteDockerTexts.removeHost, remove: true });
    const picked = await vscode.window.showQuickPick(items, {
      title: options.title ?? RemoteDockerTexts.pickTitle,
      placeHolder: RemoteDockerTexts.pickPlaceholder,
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.remove) return REMOVE_CHOICE;
    if (picked.setUp !== undefined) return { setUp: picked.setUp };
    if (picked.host !== undefined) return picked.host;
    const typed = await vscode.window.showInputBox({
      title: RemoteDockerTexts.pickTitle,
      prompt: RemoteDockerTexts.addressPrompt,
      placeHolder: 'me@build-box',
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        const parsed = parseSshAddress(value);
        return parsed.ok ? undefined : RemoteDockerTexts.addressProblem(parsed.problem);
      },
    });
    if (typed === undefined) return undefined;
    const parsed = parseSshAddress(typed);
    if (!parsed.ok) {
      this.showError(RemoteDockerTexts.addressProblem(parsed.problem));
      return undefined;
    }
    return parsed.address;
  }

  /** The SSH hosts of the Docker contexts of the user (sshHostsOfContexts); none when they cannot be listed (logged). */
  private async contextHosts(): Promise<Array<{ host: string; context: string }>> {
    if (!this.deps.docker.isInstalled()) return [];
    try {
      return await sshHostsOfContexts(this.deps.docker);
    } catch (error) {
      this.deps.logger.warn(`The Docker contexts could not be listed: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Whether the WSL distribution of Devspaces is registered, for the choice of the host (WSL compares the names without
   * case): `none` where Devspaces uses no WSL (macOS, Linux), `unknown` when the distributions cannot be listed
   * (logged).
   */
  private async wslState(): Promise<'exists' | 'missing' | 'unknown' | 'none'> {
    if (this.deps.wslDistributions === undefined) return 'none';
    try {
      return (await this.deps.wslDistributions()).some((name) => name.toLowerCase() === WSL_DISTRIBUTION) ? 'exists' : 'missing';
    } catch (error) {
      this.deps.logger.warn(`The WSL distributions could not be listed: ${errorMessage(error)}`);
      return 'unknown';
    }
  }

  /**
   * Whether the Lima VM of Devspaces exists, for the choice of the host: `none` without a Lima VM of Devspaces on this
   * computer (Windows), `unknown` when it cannot be checked (logged).
   */
  private async limaState(): Promise<'exists' | 'missing' | 'unknown' | 'none'> {
    if (this.deps.limaVmExists === undefined) return 'none';
    try {
      return (await this.deps.limaVmExists()) ? 'exists' : 'missing';
    } catch (error) {
      this.deps.logger.warn(`The Lima VM of Devspaces could not be checked: ${errorMessage(error)}`);
      return 'unknown';
    }
  }

  private async afterSwitch(): Promise<void> {
    await this.deps.onDidSwitch().catch((error: unknown) => this.deps.logger.error('Could not update the sidebar.', error));
  }

  private showFailure(error: unknown): void {
    if (isAbortError(error)) {
      this.deps.logger.info('The change of the Docker host was cancelled.');
      return;
    }
    if (isUserFacingError(error)) {
      this.deps.logger.error(error.message, error);
      this.showError(error.message);
      return;
    }
    this.deps.logger.error(RemoteDockerTexts.switchFailed, error);
    this.showError(RemoteDockerTexts.switchFailed);
  }

  /** An error with Show details, and Remove and Set Up Again after it (`resetWsl`, its command; as errors.ts shows it). */
  private showError(message: string, action?: 'resetWsl'): void {
    const items = action === undefined ? [Actions.showDetails] : [Actions.showDetails, Actions[action]];
    showErrorMessage(message, ...items).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
        else if (action !== undefined && choice === Actions[action]) {
          vscode.commands
            .executeCommand(Commands.resetWslDistribution)
            .then(undefined, (error: unknown) => this.deps.logger.error('The WSL distribution of Devspaces could not be set up again.', error));
        }
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}

/** HostName and User of an entry, for the quick pick: `me@build-box.example.com:2222`. */
export function describeEntry(entry: SshHostEntry): string | undefined {
  if (entry.hostName === undefined && entry.user === undefined && entry.port === undefined) return undefined;
  const user = entry.user !== undefined ? `${entry.user}@` : '';
  const port = entry.port !== undefined ? `:${entry.port}` : '';
  return `${user}${entry.hostName ?? entry.alias}${port}`;
}
