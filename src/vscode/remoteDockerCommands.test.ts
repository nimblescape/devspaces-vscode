// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { remoteDockerTarget, LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import { DockerTargets, NO_DOCKER_HOST_TARGET, runWithDockerTarget, operationDockerTarget } from '../core/docker/dockerTargets';
import { ENGINE_INFO_FORMAT } from '../core/docker/remoteDocker';
import { Actions, Messages, dockerHostReason } from '../core/messages';
import type { RunOptions, RunResult } from '../core/ports';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { RemoteDockerCommands, RemoteDockerTexts, describeEntry, type RemoteDockerDeps } from './remoteDockerCommands';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });

/**
 * A Docker CLI with the contexts of the user: `context ls` and `context inspect` (the current one), and `info` with -H
 * (the tested host; `hosts` answers per SSH host). Any other context command counts as a change (`changes`).
 */
class FakeCli {
  readonly calls: Array<{ args: string[]; options?: RunOptions }> = [];
  contexts = new Map<string, string>([
    ['default', 'unix:///var/run/docker.sock'],
    ['desktop-linux', 'unix:///home/me/.docker/desktop/docker.sock'],
  ]);
  current = 'desktop-linux';
  hosts = new Map<string, RunResult>();

  isInstalled = () => true;
  /** BootstrapDocker.canRunRemote; without it, isInstalled counts. */
  canRunRemote: (() => boolean) | undefined = undefined;
  processEnv = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent' });

  run = async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
    this.calls.push({ args: [...args], options });
    if (args[0] === '-H') return this.hosts.get(args[1].slice('ssh://'.length)) ?? fail('ssh: Could not resolve hostname');
    if (args[0] !== 'context') return ok();
    if (args[1] === 'ls') {
      return ok([...this.contexts].map(([name, endpoint]) => `${JSON.stringify({ Name: name, Description: '', DockerEndpoint: endpoint })}\n`).join(''));
    }
    if (args[1] === 'inspect') {
      return ok(JSON.stringify({ Name: this.current, Endpoints: { docker: { Host: this.contexts.get(this.current) } } }));
    }
    return fail('unknown');
  };

  /** The context commands that change something (`create`, `update`, `use`, `rm`): Devspaces never runs one. */
  get changes(): string[][] {
    return this.calls.filter((call) => call.args[0] === 'context' && !['ls', 'inspect'].includes(call.args[1])).map((call) => call.args);
  }
}

const engineInfo = (rootless = false): RunResult =>
  ok(JSON.stringify({ version: '28.1.0', securityOptions: rootless ? ['name=rootless'] : ['name=seccomp,profile=builtin'] }));

let dir: string;
let cli: FakeCli;
let state: RemoteDockerState;
let targets: DockerTargets;
let runner: { run: Mock<(file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>> };
let onDidSwitch: Mock<() => Promise<void>>;
let showLog: Mock<() => void>;
let devspaceCount: Mock<(host: string) => Promise<number>>;
let env: NodeJS.ProcessEnv;
let commands: RemoteDockerCommands;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const { window } = fakeVscode;

function create(extra: Partial<RemoteDockerDeps> = {}): RemoteDockerCommands {
  // As extension.ts: Devspaces never uses the Docker of this computer (R-ENG-001).
  targets = new DockerTargets(cli, env, logger, 'linux', state, false);
  const created = new RemoteDockerCommands({
    docker: cli,
    runner,
    targets,
    state,
    logger,
    showLog,
    sshHosts: () => [
      { alias: 'build-box', hostName: 'build-box.example.com', user: 'me' },
      { alias: 'gpu', port: '2222' },
    ],
    sshPath: () => '/usr/bin/ssh',
    env,
    devspaceCount,
    onDidSwitch,
    ...extra,
  });
  return created;
}

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-ui-'));
  cli = new FakeCli();
  state = new RemoteDockerState(path.join(dir, 'remote-docker.json'));
  runner = { run: vi.fn(async () => ok('/run/user/1000')) };
  onDidSwitch = vi.fn(async () => {});
  showLog = vi.fn();
  devspaceCount = vi.fn(async () => 0);
  env = { PATH: '/usr/bin' };
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  );
  commands = create();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Item = { label: string; description?: string; kind?: number };

/** The user picks the entries with the labels `labels`, one per quick pick, in this order. */
function pick(...labels: string[]): void {
  for (const label of labels) window.showQuickPick.mockImplementationOnce(async (items: Item[]) => items.find((item) => item.label === label));
}

/** The labels and descriptions of the entries of quick pick number `index`. */
function shown(index = 0): Array<[string, string | undefined]> {
  return (window.showQuickPick.mock.calls[index][0] as Item[]).map((item) => [item.label, item.description]);
}

/** The list of Devspaces holds `hosts`; Devspaces uses `current` (no host when undefined). */
async function listed(hosts: string[], current?: string): Promise<void> {
  for (const host of hosts) await state.setDockerHost(host);
  await state.setDockerHost(current);
}

describe('Use a Remote Docker Host…', () => {
  it('lists the hosts of the SSH config with HostName and User, and "Enter an SSH address…" last', async () => {
    await commands.useRemoteHost();
    expect(shown()).toEqual([
      [RemoteDockerTexts.sshConfigGroup, undefined],
      ['build-box', 'me@build-box.example.com'],
      ['gpu', 'gpu:2222'],
      ['', undefined],
      [RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail],
    ]);
    const [items, options] = window.showQuickPick.mock.calls[0] as [Item[], { title: string }];
    expect(items[0].kind).toBe(fakeVscode.QuickPickItemKind.Separator);
    expect(options.title).toBe('Use a Remote Docker Host');
    // Cancelled: only the contexts were read.
    expect(cli.calls.map((call) => call.args.slice(0, 2))).toEqual([['context', 'ls']]);
  });

  it('lists the hosts of the list first, then the SSH config, then the SSH hosts of the Docker contexts, each host once', async () => {
    await listed(['old-box', 'build-box']);
    cli.contexts.set('mine', 'ssh://me@ctx-box');
    cli.contexts.set('again', 'ssh://build-box');
    cli.contexts.set('tcp', 'tcp://192.0.2.10:2376');
    await commands.useRemoteHost();
    expect(shown()).toEqual([
      [RemoteDockerTexts.listGroup, undefined],
      ['old-box', undefined],
      ['build-box', 'me@build-box.example.com'],
      [RemoteDockerTexts.sshConfigGroup, undefined],
      ['gpu', 'gpu:2222'],
      [RemoteDockerTexts.contextGroup, undefined],
      ['me@ctx-box', 'Docker context mine'],
      ['', undefined],
      [RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail],
      [RemoteDockerTexts.removeHost, undefined],
    ]);
  });

  it('offers the WSL distribution of Devspaces when it is registered and not in the list', async () => {
    const wslDistributions = vi.fn(async () => ['Ubuntu', 'Devspaces']);
    commands = create({ wslDistributions });
    await commands.useRemoteHost();
    expect(shown().slice(-4)).toEqual([
      [RemoteDockerTexts.wslGroup, undefined],
      [WSL_HOST, RemoteDockerTexts.wslDistribution('devspaces')],
      ['', undefined],
      [RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail],
    ]);
    // In the list, it shows there; another distribution is never offered, and a failed list offers none (logged).
    await listed([WSL_HOST]);
    await commands.useRemoteHost();
    expect(shown(1).slice(0, 2)).toEqual([
      [RemoteDockerTexts.listGroup, undefined],
      [WSL_HOST, RemoteDockerTexts.wslDistribution('devspaces')],
    ]);
    expect(shown(1).filter(([label]) => label === RemoteDockerTexts.wslGroup)).toEqual([]);
    await state.removeHost(WSL_HOST);
    // Not registered: its setup instead (below); a list that fails offers neither (logged).
    wslDistributions.mockResolvedValueOnce(['Ubuntu']);
    await commands.useRemoteHost();
    expect(shown(2).some(([label]) => label === WSL_HOST)).toBe(false);
    expect(shown(2).filter(([label]) => label === RemoteDockerTexts.wslGroup)).toHaveLength(1);
    wslDistributions.mockRejectedValueOnce(new Error('wsl.exe --list --quiet failed: exit code 1'));
    await commands.useRemoteHost();
    expect(shown(3).some(([label]) => label === WSL_HOST || label === RemoteDockerTexts.wslGroup)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('The WSL distributions could not be listed: wsl.exe --list --quiet failed: exit code 1');
  });

  it('offers the Lima VM of Devspaces when it exists, and tests it on its shell without ssh:// and without docker -H', async () => {
    const limaVmExists = vi.fn(async () => true);
    const shells = {
      login: vi.fn(async () => ({ ok: true as const })),
      run: vi.fn(async () => engineInfo()),
    };
    commands = create({ limaVmExists, shells });
    await commands.useRemoteHost();
    expect(shown().slice(-4)).toEqual([
      [RemoteDockerTexts.limaGroup, undefined],
      [LIMA_HOST, RemoteDockerTexts.limaVm],
      ['', undefined],
      [RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail],
    ]);
    pick(LIMA_HOST);
    await commands.useRemoteHost();
    expect(shells.login).toHaveBeenCalledWith(LIMA_HOST, expect.any(AbortSignal), { fresh: true });
    expect(await state.dockerHost()).toBe(LIMA_HOST);
    expect(cli.calls.filter((call) => call.args[0] === '-H')).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(`Devspaces uses ${LIMA_HOST} (lima://devspaces). No Docker context was changed.`);
    expect(RemoteDockerTexts.testing(LIMA_HOST)).toBe('Starting and testing the VM of Devspaces…');
    // A VM that does not exist is not offered (its setup instead, below), and one that cannot be checked gets no entry
    // at all (logged).
    await state.setDockerHost(undefined);
    await state.removeHost(LIMA_HOST);
    limaVmExists.mockResolvedValueOnce(false);
    await commands.useRemoteHost();
    expect(shown(2).some(([label]) => label === LIMA_HOST)).toBe(false);
    limaVmExists.mockRejectedValueOnce(new Error('EACCES'));
    await commands.useRemoteHost();
    expect(shown(3).some(([label]) => label === LIMA_HOST || label === RemoteDockerTexts.limaGroup)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('The Lima VM of Devspaces could not be checked: EACCES');
  });

  it('tests the WSL distribution on its shell (wsl.exe) and uses it, without ssh and without docker -H', async () => {
    const shells = {
      login: vi.fn(async () => ({ ok: true as const })),
      run: vi.fn(async () => engineInfo()),
    };
    commands = create({ wslDistributions: async () => ['devspaces'], shells });
    pick(WSL_HOST);
    await commands.useRemoteHost();
    expect(shells.login).toHaveBeenCalledWith(WSL_HOST, expect.any(AbortSignal), { fresh: true });
    expect(await state.dockerHost()).toBe(WSL_HOST);
    expect(cli.calls.filter((call) => call.args[0] === '-H')).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(`Devspaces uses ${WSL_HOST} (wsl://devspaces). No Docker context was changed.`);
    // Its progress says that the first start can take some minutes (a slow virtual machine).
    expect(RemoteDockerTexts.testing(WSL_HOST)).toContain('can take some minutes');
    expect(RemoteDockerTexts.testing('box')).toBe('Testing the connection to box…');
    // Without wsl.exe (no shell), the plain reason, and nothing changes.
    await state.setDockerHost(undefined);
    commands = create({ wslDistributions: async () => ['devspaces'], shells: { login: vi.fn(async () => undefined), run: vi.fn(async () => undefined) } });
    pick(WSL_HOST);
    await commands.useRemoteHost();
    expect(window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerHostUnreachable(WSL_HOST, dockerHostReason('wslMissing', WSL_HOST)), Actions.showDetails);
    expect(await state.dockerHost()).toBeUndefined();
  });

  it('tests the host without questions and makes it the Docker host of Devspaces; no Docker context is changed', async () => {
    cli.hosts.set('build-box', engineInfo());
    pick('build-box');
    await commands.useRemoteHost();
    // The test: docker -H ssh://build-box info, without questions.
    const test = cli.calls.find((call) => call.args[0] === '-H');
    expect(test?.args).toEqual(['-H', 'ssh://build-box', 'info', '--format', ENGINE_INFO_FORMAT]);
    expect(test?.options?.env?.SSH_ASKPASS_REQUIRE).toBe('never');
    // No modal: nothing outside of Devspaces changes.
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(await state.dockerHost()).toBe('build-box');
    expect(await state.remoteHosts()).toEqual(['build-box']);
    expect(cli.changes).toEqual([]);
    expect(cli.current).toBe('desktop-linux');
    expect(targets.last).toEqual(remoteDockerTarget('build-box'));
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.nowRemote('build-box', false));
    expect(RemoteDockerTexts.nowRemote('build-box', false)).toContain('The docker command in your terminals keeps its Docker context.');
    expect(logger.info).toHaveBeenCalledWith('Devspaces uses build-box (ssh://build-box). No Docker context was changed.');
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
  });

  // Devspaces gives its remote calls DOCKER_HOST itself, so DOCKER_HOST of VS Code does not stop it.
  it('works also while DOCKER_HOST is set for VS Code', async () => {
    env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    commands = create();
    cli.hosts.set('build-box', engineInfo());
    pick('build-box');
    await commands.useRemoteHost();
    expect(await state.dockerHost()).toBe('build-box');
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows the plain reason and changes nothing when the host cannot be used', async () => {
    cli.hosts.set('build-box', fail('Host key verification failed.'));
    pick('build-box');
    window.showErrorMessage.mockResolvedValue('Show details');
    await commands.useRemoteHost();
    expect(window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerHostUnreachable('build-box', dockerHostReason('hostKey', 'build-box')), 'Show details');
    expect(await state.dockerHost()).toBeUndefined();
    expect(await state.remoteHosts()).toEqual([]);
    expect(onDidSwitch).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showLog).toHaveBeenCalledTimes(1);
  });

  it('takes a typed SSH address after validation', async () => {
    cli.hosts.set('me@192.0.2.10:2222', engineInfo());
    pick(RemoteDockerTexts.enterAddress);
    window.showInputBox.mockImplementation(async (options: { validateInput: (value: string) => string | undefined }) => {
      expect(options.validateInput('-oProxyCommand=x')).toBe(RemoteDockerTexts.addressProblem('option'));
      expect(options.validateInput('me@2001:db8::1')).toBe(RemoteDockerTexts.addressProblem('ipv6'));
      expect(options.validateInput('me@192.0.2.10:2222')).toBeUndefined();
      return ' me@192.0.2.10:2222 ';
    });
    await commands.useRemoteHost();
    expect(await state.dockerHost()).toBe('me@192.0.2.10:2222');
    expect(cli.changes).toEqual([]);
  });

  it('a switch from host A to host B keeps both in the list, and leaves an operation that runs on A on A', async () => {
    cli.hosts.set('build-box', engineInfo());
    cli.hosts.set('gpu', engineInfo());
    pick('build-box');
    await commands.useRemoteHost();
    const pinned = await targets.resolve();
    await runWithDockerTarget(pinned, async () => {
      pick('gpu');
      await commands.useRemoteHost();
      expect(operationDockerTarget()).toEqual(remoteDockerTarget('build-box'));
    });
    expect(await state.dockerHost()).toBe('gpu');
    expect(await state.remoteHosts()).toEqual(['build-box', 'gpu']);
  });

  it('says so for the host that Devspaces uses already, and tests nothing', async () => {
    await listed(['build-box'], 'build-box');
    pick('$(check) build-box');
    await commands.useRemoteHost();
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.alreadyHost('build-box'));
    expect(cli.calls.filter((call) => call.args[0] === '-H')).toEqual([]);
  });

  it('checks the SSH login first (BatchMode) and does not ask Docker when it fails', async () => {
    cli.hosts.set('build-box', engineInfo());
    pick('build-box');
    runner.run.mockImplementation(async (_file: string, args: readonly string[]) =>
      args[args.length - 1] === 'true' ? { exitCode: 255, stdout: '', stderr: 'Host key verification failed.', timedOut: false } : ok('/run/user/1000'),
    );
    await commands.useRemoteHost();
    expect(window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerHostUnreachable('build-box', dockerHostReason('hostKey', 'build-box')), 'Show details');
    expect(cli.calls.filter((call) => call.args[0] === '-H')).toEqual([]);
    expect(await state.dockerHost()).toBeUndefined();
  });

  it('records the socket of a rootless engine (read once with ssh, BatchMode) before the switch', async () => {
    cli.hosts.set('build-box', engineInfo(true));
    pick('build-box');
    await commands.useRemoteHost();
    // The ssh check runs first.
    expect(runner.run).toHaveBeenCalledTimes(2);
    const [file, args] = runner.run.mock.calls[1];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['--', 'build-box', 'printf %s "$XDG_RUNTIME_DIR"']);
    expect(await state.rootlessSocket('build-box')).toBe('/run/user/1000/docker.sock');
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.nowRemote('build-box', true));
  });

  // Without a Docker CLI on this computer, and none of Devspaces for it, the missing CLI is the reason, not the host.
  it('names the missing Docker CLI after the pick when Docker publishes none for this computer', async () => {
    cli.isInstalled = () => false;
    pick('build-box');
    await commands.useRemoteHost();
    expect(window.showErrorMessage.mock.calls[0]?.[0]).toBe(RemoteDockerTexts.cliMissing);
    expect(cli.calls).toEqual([]);
    expect(await state.dockerHost()).toBeUndefined();
  });

  // A computer without Docker: the Docker CLI of Devspaces is downloaded after the pick (not before: a cancelled pick
  // downloads nothing), then the host is tested with it and used.
  it('downloads the Docker CLI of Devspaces after the pick on a computer without a Docker CLI, then tests and uses the host', async () => {
    let own: string | undefined;
    cli.isInstalled = () => false;
    cli.canRunRemote = () => own !== undefined;
    const installOwnCli = vi.fn(async () => (own = '/storage/docker-cli/29.9.2/docker'));
    commands = create({ installOwnCli });
    await commands.useRemoteHost();
    expect(installOwnCli).not.toHaveBeenCalled();
    cli.hosts.set('build-box', engineInfo());
    pick('build-box');
    await commands.useRemoteHost();
    expect(installOwnCli).toHaveBeenCalledTimes(1);
    expect(cli.calls.map((call) => call.args.slice(0, 3))).toEqual([['-H', 'ssh://build-box', 'info']]);
    expect(await state.dockerHost()).toBe('build-box');
    expect(targets.last).toEqual(remoteDockerTarget('build-box'));
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
  });

  // The download shows its own message when it fails; a cancel shows none.
  it('sets no host and tests nothing when the download of the Docker CLI of Devspaces fails or is cancelled', async () => {
    cli.isInstalled = () => false;
    cli.canRunRemote = () => false;
    const installOwnCli = vi.fn(async () => undefined);
    commands = create({ installOwnCli });
    pick('build-box');
    await commands.useRemoteHost();
    expect(installOwnCli).toHaveBeenCalledTimes(1);
    expect(cli.calls).toEqual([]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(await state.dockerHost()).toBeUndefined();
  });

  // The host of the list that no Docker CLI reaches (its Docker CLI of Devspaces was removed): DockerTargets.resolve
  // gave the local Docker, so the setup shows; the choice of that host downloads and tests as a new choice.
  it('downloads the Docker CLI of Devspaces for the host that Devspaces uses already when no Docker CLI reaches it', async () => {
    await listed(['build-box'], 'build-box');
    let own: string | undefined;
    cli.isInstalled = () => false;
    cli.canRunRemote = () => own !== undefined;
    const installOwnCli = vi.fn(async () => (own = '/storage/docker-cli/29.9.2/docker'));
    commands = create({ installOwnCli });
    cli.hosts.set('build-box', engineInfo());
    pick('$(check) build-box');
    await commands.useRemoteHost();
    expect(installOwnCli).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).not.toHaveBeenCalledWith(RemoteDockerTexts.alreadyHost('build-box'));
    expect(cli.calls.map((call) => call.args.slice(0, 3))).toEqual([['-H', 'ssh://build-box', 'info']]);
    expect(targets.last).toEqual(remoteDockerTarget('build-box'));
    // Then it is the host that Devspaces uses: said so, nothing tested.
    pick('$(check) build-box');
    await commands.useRemoteHost();
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.alreadyHost('build-box'));
    expect(installOwnCli).toHaveBeenCalledTimes(1);
    expect(cli.calls).toHaveLength(1);
  });

  // The Docker CLI of Devspaces that another window downloaded, or the Docker CLI of this computer: no download.
  it('downloads nothing while a Docker CLI runs the calls on a remote engine', async () => {
    cli.isInstalled = () => false;
    cli.canRunRemote = () => true;
    const installOwnCli = vi.fn(async () => '/storage/docker-cli/29.9.2/docker');
    commands = create({ installOwnCli });
    cli.hosts.set('build-box', engineInfo());
    pick('build-box');
    await commands.useRemoteHost();
    expect(installOwnCli).not.toHaveBeenCalled();
    expect(await state.dockerHost()).toBe('build-box');
  });
});

// The choice of the Docker host (from the first row of the list).
describe('Choose the Docker Host… (the choice of the first row)', () => {
  it('lists the hosts with the current one marked, and "Enter an SSH address…", without the local Docker', async () => {
    await listed(['build-box', 'me@192.0.2.10:2222'], 'me@192.0.2.10:2222');
    await commands.chooseDockerHost();
    expect(shown()).toEqual([
      [RemoteDockerTexts.listGroup, undefined],
      ['build-box', 'me@build-box.example.com'],
      ['$(check) me@192.0.2.10:2222', RemoteDockerTexts.current],
      [RemoteDockerTexts.sshConfigGroup, undefined],
      ['gpu', 'gpu:2222'],
      ['', undefined],
      [RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail],
      [RemoteDockerTexts.removeHost, undefined],
    ]);
    const options = window.showQuickPick.mock.calls[0][1] as { title: string; placeHolder: string };
    expect(options.title).toBe('Docker host: me@192.0.2.10:2222');
    expect(options.placeHolder).toBe(RemoteDockerTexts.pickPlaceholder);
  });

  // docs/requirements.md R-ENG-001: Devspaces never uses the Docker of this computer, on any platform.
  it('says in its title that Devspaces has no host yet, and reads no Docker context of this computer', async () => {
    await commands.chooseDockerHost();
    expect(shown().at(-1)).toEqual([RemoteDockerTexts.enterAddress, RemoteDockerTexts.enterAddressDetail]);
    expect((window.showQuickPick.mock.calls[0][1] as { title: string }).title).toBe('Docker host: none');
    expect(targets.last).toBeUndefined();
    expect(cli.calls.filter((call) => call.args[0] === 'context' && call.args[1] !== 'ls')).toEqual([]);
  });

  it('switches to the picked host, and says so for the current one', async () => {
    cli.hosts.set('gpu', engineInfo());
    pick('gpu');
    await commands.chooseDockerHost();
    expect(await state.dockerHost()).toBe('gpu');
    pick('$(check) gpu');
    await commands.chooseDockerHost();
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.alreadyHost('gpu'));
    expect(cli.changes).toEqual([]);
  });

  it('changes nothing when the choice is cancelled', async () => {
    await listed(['build-box'], 'build-box');
    await commands.chooseDockerHost();
    expect(await state.dockerHost()).toBe('build-box');
    expect(onDidSwitch).not.toHaveBeenCalled();
  });

  // Mutation: a choice without the setup while the VM does not exist fails it: a user on a remote host has no way back
  // to the VM of Devspaces, which takes the place of the local Docker on every platform.
  it('offers the setup of the Lima VM while it does not exist (macOS, Linux), and starts it; once the VM exists, the VM instead', async () => {
    const limaVmExists = vi.fn(async () => false);
    commands = create({ limaVmExists });
    await listed(['build-box'], 'build-box');
    await commands.chooseDockerHost();
    const setUp = `$(add) ${RemoteDockerTexts.setUpVm}`;
    expect(shown().filter(([label]) => label === RemoteDockerTexts.limaGroup || label === setUp)).toEqual([
      [RemoteDockerTexts.limaGroup, undefined],
      [setUp, RemoteDockerTexts.setUpVmDetail],
    ]);
    pick(setUp);
    await commands.chooseDockerHost();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('devspaces.setUpLimaVm');
    expect(await state.dockerHost()).toBe('build-box');
    expect(onDidSwitch).not.toHaveBeenCalled();
    // "Use a Remote Docker Host…" offers it too.
    pick(setUp);
    await commands.useRemoteHost();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledTimes(2);
    // The VM exists: it is offered as a host, without the setup.
    limaVmExists.mockResolvedValue(true);
    await commands.chooseDockerHost();
    const labels = shown(3).map(([label]) => label);
    expect(labels).toContain(LIMA_HOST);
    expect(labels).not.toContain(setUp);
    // A VM that cannot be checked gets no entry.
    limaVmExists.mockRejectedValue(new Error('EACCES'));
    await commands.chooseDockerHost();
    expect(shown(4).some(([label]) => label === setUp || label === LIMA_HOST)).toBe(false);
  });

  // The same on Windows, where the VM of Devspaces is its WSL distribution.
  it('offers the setup of the WSL distribution while it is not registered (Windows), and starts it; once registered, the distribution instead', async () => {
    const wslDistributions = vi.fn(async () => ['Ubuntu']);
    commands = create({ wslDistributions });
    await listed(['build-box'], 'build-box');
    await commands.chooseDockerHost();
    const setUp = `$(add) ${RemoteDockerTexts.setUpWsl}`;
    expect(shown().filter(([label]) => label === RemoteDockerTexts.wslGroup || label === setUp)).toEqual([
      [RemoteDockerTexts.wslGroup, undefined],
      [setUp, RemoteDockerTexts.setUpWslDetail],
    ]);
    // Neither the setup of the Lima VM nor the Lima group where Devspaces has no Lima VM.
    expect(shown().some(([label]) => label === RemoteDockerTexts.limaGroup || label.includes(RemoteDockerTexts.setUpVm))).toBe(false);
    pick(setUp);
    await commands.chooseDockerHost();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('devspaces.setUpWslDistribution');
    expect(await state.dockerHost()).toBe('build-box');
    // Without any distribution (also without WSL), the setup too.
    wslDistributions.mockResolvedValue([]);
    await commands.chooseDockerHost();
    expect(shown(2).map(([label]) => label)).toContain(setUp);
    // Registered: the distribution, without the setup.
    wslDistributions.mockResolvedValue(['Ubuntu', 'devspaces']);
    await commands.chooseDockerHost();
    expect(shown(3).map(([label]) => label)).toContain(WSL_HOST);
    expect(shown(3).map(([label]) => label)).not.toContain(setUp);
  });

  it('offers no setup where Devspaces has no own VM of that kind (no check of WSL or of Lima given)', async () => {
    await commands.chooseDockerHost();
    expect(shown().some(([label]) => label.startsWith('$(add)'))).toBe(false);
  });

  it('"Use the Local Docker" is no command anymore: Devspaces never uses the Docker of this computer', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string; title: string }> };
    };
    expect(manifest.contributes.commands.map((entry) => entry.title)).not.toContain('Use the Local Docker');
    expect('useLocalDocker' in commands).toBe(false);
  });
});

describe('Remove a Host from the List…', () => {
  it('removes a host that Devspaces does not use: its devspaces stay on that computer, and nothing else changes', async () => {
    await listed(['build-box', 'gpu'], 'gpu');
    devspaceCount.mockResolvedValue(2);
    pick(RemoteDockerTexts.removeHost, 'build-box');
    await commands.useRemoteHost();
    const [items, options] = window.showQuickPick.mock.calls[1] as [Item[], { title: string }];
    expect(items.map((item) => [item.label, item.description])).toEqual([
      ['build-box', undefined],
      ['gpu', RemoteDockerTexts.current],
    ]);
    expect(options.title).toBe(RemoteDockerTexts.removeTitle);
    expect(await state.remoteHosts()).toEqual(['gpu']);
    expect(await state.dockerHost()).toBe('gpu');
    expect(devspaceCount).toHaveBeenCalledWith('build-box');
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.removed('build-box', 2, false));
    expect(onDidSwitch).not.toHaveBeenCalled();
    expect(cli.calls.filter((call) => call.args[0] === '-H')).toEqual([]);
  });

  it('removing the host that Devspaces uses leaves it without a Docker host, without a warning', async () => {
    await listed(['gpu'], 'gpu');
    pick(RemoteDockerTexts.removeHost, 'gpu');
    await commands.chooseDockerHost();
    expect(await state.remoteHosts()).toEqual([]);
    expect(await state.dockerHost()).toBeUndefined();
    expect(targets.last).toBe(NO_DOCKER_HOST_TARGET);
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.removed('gpu', 0, true));
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
    // No Docker context of this computer is read for the target (the choice lists only the SSH hosts of the contexts).
    expect(cli.calls.filter((call) => call.args[0] === 'context' && call.args[1] !== 'ls')).toEqual([]);
  });

  it('says how many devspaces stay, and that Devspaces has no Docker host when it used the removed one', () => {
    expect(RemoteDockerTexts.removed('box', 0, false)).toBe('box is no longer in the list of Devspaces.');
    expect(RemoteDockerTexts.removed('box', 1, false)).toBe('box is no longer in the list of Devspaces. Its devspace stays on that computer: add box again to show it in the sidebar.');
    expect(RemoteDockerTexts.removed('box', 2, true)).toBe(
      'box is no longer in the list of Devspaces. Its 2 devspaces stay on that computer: add box again to show them in the sidebar. Devspaces has no Docker host now: set up Docker for Devspaces in the Devspaces view, or choose another host.',
    );
  });
});

describe('useHost and forgetHost (the WSL distribution of Devspaces after its setup and its removal)', () => {
  const wslShells = (answers = true) => ({
    login: vi.fn(async () => (answers ? { ok: true as const } : undefined)),
    run: vi.fn(async () => (answers ? engineInfo() : undefined)),
  });

  it('useHost tests the host and uses it without a choice', async () => {
    commands = create({ shells: wslShells() });
    await expect(commands.useHost(WSL_HOST)).resolves.toBe(true);
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(await state.dockerHost()).toBe(WSL_HOST);
    expect(window.showInformationMessage).toHaveBeenCalledWith(RemoteDockerTexts.nowRemote(WSL_HOST, false));
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
  });

  it('useHost gives false and shows the reason when the host does not answer', async () => {
    commands = create({ shells: wslShells(false) });
    await expect(commands.useHost(WSL_HOST)).resolves.toBe(false);
    expect(window.showErrorMessage).toHaveBeenCalledWith(Messages.dockerHostUnreachable(WSL_HOST, dockerHostReason('wslMissing', WSL_HOST)), Actions.showDetails);
    expect(await state.dockerHost()).toBeUndefined();
  });

  it('useHost offers Remove and Set Up Again when the disk of the distribution is damaged', async () => {
    const detail = 'The file or directory is corrupted and unreadable.\r\nError code: Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_FILE_CORRUPT';
    commands = create({ shells: { login: vi.fn(async () => ({ ok: false as const, detail, timedOut: false })), run: vi.fn(async () => undefined) } });
    window.showErrorMessage.mockResolvedValue(Actions.resetWsl);
    await expect(commands.useHost(WSL_HOST)).resolves.toBe(false);
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      Messages.dockerHostUnreachable(WSL_HOST, dockerHostReason('wslDiskCorrupt', WSL_HOST)),
      Actions.showDetails,
      Actions.resetWsl,
    );
    await vi.waitFor(() => expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('devspaces.resetWslDistribution'));
    expect(await state.dockerHost()).toBeUndefined();
  });

  it('useHost downloads the Docker CLI of Devspaces first on a computer without a Docker CLI, and gives false when that fails', async () => {
    cli.isInstalled = () => false;
    const installOwnCli = vi.fn(async () => undefined);
    commands = create({ shells: wslShells(), installOwnCli });
    await expect(commands.useHost(WSL_HOST)).resolves.toBe(false);
    expect(installOwnCli).toHaveBeenCalledTimes(1);
    expect(await state.dockerHost()).toBeUndefined();
  });

  it('forgetHost removes the host from the list without a message; when it was current, Devspaces has no Docker host', async () => {
    await state.setDockerHost(WSL_HOST);
    await expect(commands.forgetHost(WSL_HOST)).resolves.toBe(true);
    expect(await state.dockerHost()).toBeUndefined();
    expect(await state.remoteHosts()).toEqual([]);
    expect(targets.last).toBe(NO_DOCKER_HOST_TARGET);
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    // Not in the list (anymore): nothing changes.
    await expect(commands.forgetHost(WSL_HOST)).resolves.toBe(false);
    expect(onDidSwitch).toHaveBeenCalledTimes(1);
  });

  it('forgetHost keeps the current host when it removes another one', async () => {
    await state.setDockerHost(WSL_HOST);
    await state.setDockerHost('build-box');
    await expect(commands.forgetHost(WSL_HOST)).resolves.toBe(false);
    expect(await state.dockerHost()).toBe('build-box');
    expect(await state.remoteHosts()).toEqual(['build-box']);
    expect(onDidSwitch).not.toHaveBeenCalled();
  });
});

describe('describeEntry', () => {
  it('shows User, HostName and Port where set', () => {
    expect(describeEntry({ alias: 'a' })).toBeUndefined();
    expect(describeEntry({ alias: 'a', user: 'me' })).toBe('me@a');
    expect(describeEntry({ alias: 'a', hostName: 'h', port: '22' })).toBe('h:22');
  });
});
