// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { findDockerCli } from '../core/docker/dockerCli';
import { DockerContextKeys, DockerSetupTexts } from '../core/docker/dockerSetup';
import type { RunResult } from '../core/ports';
import { Commands } from './commands';
import { DockerSetup, DockerSetupUiTexts, type DockerSetupDeps } from './dockerSetup';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const ROOT = path.join(__dirname, '..', '..');

function contextCalls(): Array<[string, boolean]> {
  return fakeVscode.commands.executeCommand.mock.calls
    .filter((call) => call[0] === 'setContext')
    .map((call) => [call[1] as string, call[2] as boolean]);
}

interface SetupOptions {
  platform?: NodeJS.Platform;
  wsl?: () => RunResult | Promise<RunResult>;
  /** Whether Devspaces uses a remote host (as last read); a function for one that changes. */
  remoteDockerHost?: boolean | (() => boolean);
  /** Whether the sidebar view is visible; visible when not given. */
  viewVisible?: () => boolean;
  wslAfterInstall?: DockerSetupDeps['wslAfterInstall'];
}

function setup(installed: boolean, options: SetupOptions = {}) {
  const platform = options.platform ?? 'darwin';
  const docker = { isInstalled: vi.fn(() => installed), lookUpCliNow: vi.fn(() => installed) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const changed = vi.fn();
  const runner = {
    run: vi.fn(async (_file: string, _args: readonly string[]) =>
      options.wsl ? options.wsl() : { exitCode: 1, stdout: '', stderr: '', timedOut: false },
    ),
  };
  const dockerSetup = new DockerSetup({
    docker,
    runner,
    logger,
    platform,
    env: {},
    onDidChangeInstalled: changed,
    remoteDockerHostConfigured: () => (typeof options.remoteDockerHost === 'function' ? options.remoteDockerHost() : (options.remoteDockerHost ?? false)),
    viewVisible: options.viewVisible ?? (() => true),
    wslAfterInstall: options.wslAfterInstall,
  } as unknown as DockerSetupDeps);
  return { dockerSetup, docker, logger, changed, runner };
}

/** Lets the pending promise callbacks run (the fake timers do not delay them). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function confirmWith(button: string | undefined): void {
  fakeVscode.window.showWarningMessage.mockResolvedValue(button);
}

function modalCalls(): Array<[string, { modal: boolean; detail: string }, string]> {
  return fakeVscode.window.showWarningMessage.mock.calls as Array<[string, { modal: boolean; detail: string }, string]>;
}

beforeEach(() => {
  resetFakeVscode();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerSetup: context keys and CLI checks', () => {
  it('sets all context keys at activation', () => {
    const { dockerSetup } = setup(false);
    dockerSetup.initialize();
    expect(contextCalls()).toEqual([
      [DockerContextKeys.missing, true],
      [DockerContextKeys.installed, false],
      [DockerContextKeys.ready, false],
      [DockerContextKeys.wslReady, false],
      [DockerContextKeys.setupRequired, true],
    ]);
    expect(dockerSetup.dockerMissing).toBe(true);
    expect(dockerSetup.setupRequired).toBe(true);
    dockerSetup.dispose();
  });

  it('requires no setup without a CLI when a remote Docker host is configured', () => {
    const { dockerSetup } = setup(false, { remoteDockerHost: true });
    dockerSetup.initialize();
    expect(contextCalls()).toContainEqual([DockerContextKeys.setupRequired, false]);
    expect(dockerSetup.dockerMissing).toBe(true);
    expect(dockerSetup.setupRequired).toBe(false);
    dockerSetup.dispose();
  });

  // "Use a Remote Docker Host…" on a computer without Docker, or the choice of another window: the setup follows the
  // Docker host of Devspaces (onDockerHostChanged), without a lookup of the CLI.
  it('shows or hides the setup when the Docker host of Devspaces changes, and renders the sidebar again', () => {
    let remote = false;
    const { dockerSetup, docker, changed } = setup(false, { remoteDockerHost: () => remote });
    dockerSetup.onDockerHostChanged();
    expect(contextCalls()).toEqual([]);
    dockerSetup.initialize();
    fakeVscode.commands.executeCommand.mockClear();
    const lookups = docker.isInstalled.mock.calls.length;
    dockerSetup.onDockerHostChanged();
    expect(contextCalls()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    remote = true;
    dockerSetup.onDockerHostChanged();
    expect(contextCalls()).toEqual([[DockerContextKeys.setupRequired, false]]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(dockerSetup.setupRequired).toBe(false);
    remote = false;
    dockerSetup.onDockerHostChanged();
    expect(contextCalls()).toEqual([
      [DockerContextKeys.setupRequired, false],
      [DockerContextKeys.setupRequired, true],
    ]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(docker.isInstalled.mock.calls.length).toBe(lookups);
    dockerSetup.dispose();
  });

  // Windows: the Docker of the computer (Docker Desktop) counts until the test of R-VM-008 (R-ENG-001).
  it('looks the CLI up every 10 seconds while it is missing, then stops and updates the sidebar', () => {
    const { dockerSetup, docker, changed } = setup(false, { platform: 'win32' });
    dockerSetup.initialize();
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_999);
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(docker.isInstalled).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    fakeVscode.commands.executeCommand.mockClear();

    docker.isInstalled.mockReturnValue(true);
    vi.advanceTimersByTime(10_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(3);
    expect(dockerSetup.dockerMissing).toBe(false);
    // The sidebar renders again (onDidChangeInstalled) and shows the repositories instead of the setup.
    expect(dockerSetup.setupRequired).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(contextCalls()).toEqual([
      [DockerContextKeys.missing, false],
      [DockerContextKeys.installed, true],
      [DockerContextKeys.setupRequired, false],
    ]);
    vi.advanceTimersByTime(60_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(3);
    dockerSetup.dispose();
  });

  // macOS and Linux: Devspaces never uses the Docker of the computer (R-ENG-001); only a host of its list, also its VM,
  // ends the setup.
  it('shows the setup on macOS and Linux also with a Docker CLI, until Devspaces has a Docker host of its list', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      let remote = false;
      const { dockerSetup, changed } = setup(true, { platform, remoteDockerHost: () => remote });
      dockerSetup.initialize();
      expect(dockerSetup.dockerMissing, platform).toBe(false);
      expect(dockerSetup.setupRequired, platform).toBe(true);
      expect(contextCalls(), platform).toContainEqual([DockerContextKeys.setupRequired, true]);
      fakeVscode.commands.executeCommand.mockClear();
      remote = true;
      dockerSetup.onDockerHostChanged();
      expect(dockerSetup.setupRequired, platform).toBe(false);
      expect(changed, platform).toHaveBeenCalledTimes(1);
      expect(contextCalls(), platform).toEqual([[DockerContextKeys.setupRequired, false]]);
      dockerSetup.dispose();
      fakeVscode.commands.executeCommand.mockClear();
    }
    // Windows: the Docker CLI of the computer is enough.
    const windows = setup(true, { platform: 'win32' });
    windows.dockerSetup.initialize();
    expect(windows.dockerSetup.setupRequired).toBe(false);
    windows.dockerSetup.dispose();
  });

  it('does not look up an installed CLI in the background', () => {
    const { dockerSetup, docker, changed } = setup(true);
    dockerSetup.initialize();
    vi.advanceTimersByTime(120_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(contextCalls()).toContainEqual([DockerContextKeys.missing, false]);
    dockerSetup.dispose();
  });

  it('sets dockerReady from the results of docker info that ran anyway', () => {
    const { dockerSetup } = setup(true);
    dockerSetup.initialize();
    fakeVscode.commands.executeCommand.mockClear();
    dockerSetup.reportDaemonStatus(true);
    dockerSetup.reportDaemonStatus(true);
    expect(contextCalls()).toEqual([[DockerContextKeys.ready, true]]);
    dockerSetup.reportDaemonStatus(false);
    expect(contextCalls()).toEqual([
      [DockerContextKeys.ready, true],
      [DockerContextKeys.ready, false],
    ]);
    dockerSetup.dispose();
  });

  it('stops the checks when disposed', () => {
    const { dockerSetup, docker } = setup(false);
    dockerSetup.initialize();
    dockerSetup.dispose();
    vi.advanceTimersByTime(60_000);
    expect(docker.isInstalled).toHaveBeenCalledTimes(1);
  });

  it('Show Docker Setup (action Install Docker… of an error) looks for the CLI again, then shows the sidebar', async () => {
    const { dockerSetup, docker, changed } = setup(true, { platform: 'win32' });
    dockerSetup.initialize();
    expect(dockerSetup.setupRequired).toBe(false);
    fakeVscode.commands.executeCommand.mockClear();
    // The CLI is gone, and nothing has reported it yet.
    docker.isInstalled.mockReturnValue(false);
    await dockerSetup.show();
    expect(dockerSetup.setupRequired).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    const calls = fakeVscode.commands.executeCommand.mock.calls.map((call) => call[0] as string);
    expect(calls).toContain('devspaces.repositories.focus');
    // The context key is set before the view is shown.
    expect(calls.indexOf('setContext')).toBeLessThan(calls.indexOf('devspaces.repositories.focus'));
    expect(contextCalls()).toContainEqual([DockerContextKeys.setupRequired, true]);
    dockerSetup.dispose();
  });

  it('shows the setup when the adapter reports a lost CLI (ENOENT of a CLI that was found before)', async () => {
    let found: string | undefined = '/usr/local/bin/docker';
    const runner = {
      run: vi.fn(async () => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    let dockerSetup: DockerSetup | undefined;
    const docker = new BootstrapDocker(runner, found, {}, logger, 'win32', {
      findDocker: () => found,
      // As in extension.ts: reportCliLost, which does not look the CLI up at once.
      onCliLost: () => dockerSetup?.reportCliLost(),
    });
    const changed = vi.fn();
    dockerSetup = new DockerSetup({
      docker,
      runner,
      logger,
      platform: 'win32',
      env: {},
      onDidChangeInstalled: changed,
      remoteDockerHostConfigured: () => false,
      viewVisible: () => true,
    });
    dockerSetup.initialize();
    expect(dockerSetup.setupRequired).toBe(false);
    found = undefined;
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    expect(dockerSetup.setupRequired).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(contextCalls()).toContainEqual([DockerContextKeys.setupRequired, true]);
    dockerSetup.dispose();
  });

  it('looks for a lost CLI again at the next call, so a CLI back a second later is found', async () => {
    const DOCKER = '/usr/local/bin/docker';
    let now = 1_000;
    let gone = false;
    let found: string | undefined = DOCKER;
    const lookups: number[] = [];
    const runner = {
      run: vi.fn(async () => {
        if (gone) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    let dockerSetup: DockerSetup | undefined;
    const docker = new BootstrapDocker(runner, DOCKER, {}, logger, 'darwin', {
      findDocker: () => {
        lookups.push(now);
        return found;
      },
      clock: { now: () => now },
      onCliLost: () => dockerSetup?.reportCliLost(),
    });
    const changed = vi.fn();
    dockerSetup = new DockerSetup({
      docker,
      runner,
      logger,
      platform: 'darwin',
      env: {},
      onDidChangeInstalled: changed,
      remoteDockerHostConfigured: () => false,
      viewVisible: () => true,
      clock: { now: () => now },
    });
    dockerSetup.initialize();
    now += 20_000;
    // For example while Docker Desktop updates itself: the CLI is gone for a moment.
    gone = true;
    found = undefined;
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    // The sidebar shows the setup at the loss, without a lookup.
    expect(dockerSetup.setupRequired).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(lookups).toEqual([]);
    // The CLI is back a second later: the next call looks it up and runs.
    gone = false;
    found = DOCKER;
    now += 1_000;
    expect(docker.isInstalled()).toBe(true);
    await expect(docker.run(['ps'])).resolves.toMatchObject({ exitCode: 0 });
    expect(lookups).toEqual([now]);
    dockerSetup.dispose();
  });

  it('counts a failed lookup as missing', () => {
    const { dockerSetup, docker, logger } = setup(true);
    docker.isInstalled.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(dockerSetup.checkCli()).toBe(false);
    expect(dockerSetup.dockerMissing).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    dockerSetup.dispose();
  });
});

describe('DockerSetup: WSL 2 (sidebar button Install WSL 2, Windows)', () => {
  const status = (exitCode: number): RunResult => ({ exitCode, stdout: '', stderr: '', timedOut: false });

  it('checks wsl --status at activation while Docker is missing and the view is visible', async () => {
    const { dockerSetup, runner } = setup(false, { platform: 'win32', wsl: () => status(0) });
    dockerSetup.initialize();
    await flush();
    expect(runner.run).toHaveBeenCalledWith('wsl.exe', ['--status'], { timeoutMs: 15_000 });
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    dockerSetup.dispose();
  });

  it('checks wsl --status only when the hidden view is shown, again while WSL is not ready', async () => {
    let visible = false;
    let exitCode = 1;
    const { dockerSetup, runner } = setup(false, { platform: 'win32', wsl: () => status(exitCode), viewVisible: () => visible });
    dockerSetup.initialize();
    await flush();
    expect(runner.run).not.toHaveBeenCalled();
    visible = true;
    dockerSetup.onViewShown();
    await flush();
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, false]);
    // Not ready: shown again, checked again.
    exitCode = 0;
    dockerSetup.onViewShown();
    await flush();
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    // Ready: no further check.
    dockerSetup.onViewShown();
    await flush();
    expect(runner.run).toHaveBeenCalledTimes(2);
    dockerSetup.dispose();
  });

  it('does not run wsl on other platforms, when Docker is installed, or with a remote Docker host, also when the view is shown', async () => {
    const mac = setup(false, { platform: 'darwin' });
    mac.dockerSetup.initialize();
    mac.dockerSetup.onViewShown();
    const installed = setup(true, { platform: 'win32' });
    installed.dockerSetup.initialize();
    installed.dockerSetup.onViewShown();
    const remote = setup(false, { platform: 'win32', remoteDockerHost: true });
    remote.dockerSetup.initialize();
    remote.dockerSetup.onViewShown();
    await flush();
    expect(mac.runner.run).not.toHaveBeenCalled();
    expect(installed.runner.run).not.toHaveBeenCalled();
    expect(remote.runner.run).not.toHaveBeenCalled();
    mac.dockerSetup.dispose();
    installed.dockerSetup.dispose();
    remote.dockerSetup.dispose();
  });

  it('Install WSL 2 waits for a first check: it runs one when none ran, or waits for the one that runs', async () => {
    // No check yet (the view was hidden): the click checks first, and WSL is ready.
    const hidden = setup(false, { platform: 'win32', wsl: () => status(0), viewVisible: () => false });
    hidden.dockerSetup.initialize();
    await flush();
    expect(hidden.runner.run).not.toHaveBeenCalled();
    confirmWith('Install');
    await hidden.dockerSetup.installWsl();
    expect(hidden.runner.run).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.terminals).toEqual([]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.wslAlreadyInstalled);
    hidden.dockerSetup.dispose();
    // A click while the check of the activation runs waits for that check (one check at a time).
    let answer: (result: RunResult) => void = () => {};
    const running = setup(false, { platform: 'win32', wsl: () => new Promise<RunResult>((resolve) => (answer = resolve)) });
    running.dockerSetup.initialize();
    const click = running.dockerSetup.installWsl();
    await flush();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    answer(status(0));
    await click;
    expect(running.runner.run).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    expect(fakeVscode.terminals).toEqual([]);
    running.dockerSetup.dispose();
  });

  it('runs no wsl --install when WSL 2 is installed already', async () => {
    const { dockerSetup } = setup(false, { platform: 'win32', wsl: () => status(0) });
    dockerSetup.initialize();
    await flush();
    confirmWith('Install');
    await dockerSetup.installWsl();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.terminals).toEqual([]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.wslAlreadyInstalled);
    dockerSetup.dispose();
  });

  it('checks wsl --status when a CLI found at activation is lost', async () => {
    let found: string | undefined = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
    const runner = {
      run: vi.fn(async (file: string, _args: readonly string[]): Promise<RunResult> => {
        if (file === 'wsl.exe') return status(0);
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    let dockerSetup: DockerSetup | undefined;
    const docker = new BootstrapDocker(runner, found, {}, logger, 'win32', {
      findDocker: () => found,
      onCliLost: () => dockerSetup?.reportCliLost(),
    });
    const visible = true;
    dockerSetup = new DockerSetup({
      docker,
      runner,
      logger,
      platform: 'win32',
      env: {},
      onDidChangeInstalled: vi.fn(),
      remoteDockerHostConfigured: () => false,
      viewVisible: () => visible,
    });
    dockerSetup.initialize();
    await flush();
    // The CLI was found at activation: no wsl --status yet.
    expect(runner.run).not.toHaveBeenCalledWith('wsl.exe', expect.anything(), expect.anything());
    found = undefined;
    await expect(docker.run(['ps'])).rejects.toMatchObject({ code: 'dockerNotInstalled' });
    await flush();
    expect(dockerSetup.setupRequired).toBe(true);
    expect(runner.run).toHaveBeenCalledWith('wsl.exe', ['--status'], { timeoutMs: 15_000 });
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    // WSL is installed: Install WSL 2 asks nothing and runs no wsl --install.
    confirmWith('Install');
    await dockerSetup.installWsl();
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.terminals).toEqual([]);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerSetupUiTexts.wslAlreadyInstalled);
    dockerSetup.dispose();
  });

  // The installer of Docker Desktop installs for the user by default (in %LOCALAPPDATA%\Programs\DockerDesktop) and adds
  // the folder to the PATH of the user, which VS Code, started before the installation, does not see.
  it('finds a per-user Docker Desktop that the user installed, with the PATH from before it', async () => {
    const env = { Path: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\octo\\AppData\\Local' };
    const cli = 'C:\\Users\\octo\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe';
    const files = new Set<string>();
    const runner = { run: vi.fn(async (_file: string, _args: readonly string[]): Promise<RunResult> => status(0)) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
    const docker = new BootstrapDocker(runner, findDockerCli(env, 'win32', (file) => files.has(file)), env, logger, 'win32', {
      findDocker: (lookupEnv, platform) => findDockerCli(lookupEnv, platform, (file) => files.has(file)),
    });
    const changed = vi.fn();
    const dockerSetup = new DockerSetup({
      docker,
      runner,
      logger,
      platform: 'win32',
      env,
      onDidChangeInstalled: changed,
      remoteDockerHostConfigured: () => false,
      viewVisible: () => true,
    });
    dockerSetup.initialize();
    await flush();
    expect(dockerSetup.setupRequired).toBe(true);
    // The installer puts the CLI in place; the check of a missing CLI finds it.
    files.add(cli);
    vi.advanceTimersByTime(10_000);
    expect(dockerSetup.setupRequired).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(docker.dockerPath).toBe(cli);
    // The Docker calls find the credential helper of Docker Desktop next to the CLI.
    expect(docker.processEnv().Path).toBe(`C:\\Windows\\System32;${path.win32.dirname(cli)};C:\\Program Files\\Docker\\Docker\\resources\\bin`);
    dockerSetup.dispose();
  });

  it('a CLI lost while the view is hidden: wsl --status when the view is shown', async () => {
    let visible = false;
    const { dockerSetup, runner } = setup(true, { platform: 'win32', wsl: () => status(0), viewVisible: () => visible });
    dockerSetup.initialize();
    dockerSetup.reportCliLost();
    await flush();
    expect(dockerSetup.setupRequired).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
    visible = true;
    dockerSetup.onViewShown();
    await flush();
    expect(runner.run).toHaveBeenCalledWith('wsl.exe', ['--status'], { timeoutMs: 15_000 });
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    dockerSetup.dispose();
  });

  // Mutation: a question before the installation fails it (Windows asks for administrator permission itself); so does an
  // installation without the record (nothing would go on after the restart of Windows).
  it('runs wsl --install in the terminal without a question, notes it for after the restart, and says to restart when WSL is ready', async () => {
    let exitCode = 1;
    const started = vi.fn(async () => undefined);
    const { dockerSetup, runner } = setup(false, { platform: 'win32', wsl: () => status(exitCode), wslAfterInstall: { started } });
    const link = { path: '/open', query: 'repository=octo/app' };
    await dockerSetup.installWsl(link);
    expect(modalCalls()).toEqual([]);
    expect(started.mock.calls).toEqual([[link]]);
    // Without the Ubuntu that `wsl --install` adds by default.
    expect(fakeVscode.terminals[0].lines).toEqual(['wsl --install --no-distribution']);
    expect(fakeVscode.window.showInformationMessage.mock.calls).toEqual([[DockerSetupTexts.wslInstalling('Install Docker', 'wsl --install --no-distribution')]]);
    expect(DockerSetupTexts.wslInstalling('Install Docker', 'wsl --install --no-distribution')).toContain('Windows asks for administrator permission');
    // The first check, before the installation (no check ran before the click).
    expect(runner.run).toHaveBeenCalledTimes(1);
    exitCode = 0;
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    // WSL is installed: Windows restarts, then the first window goes on (Controller.goOnAfterWslInstall).
    expect(fakeVscode.window.showInformationMessage).toHaveBeenLastCalledWith(DockerSetupTexts.wslRestartToGoOn);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    dockerSetup.dispose();
  });

  it('says nothing about a restart when WSL was ready without an installation of this window', async () => {
    const { dockerSetup } = setup(false, { platform: 'win32', wsl: () => status(0) });
    dockerSetup.initialize();
    await flush();
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, true]);
    expect(fakeVscode.window.showInformationMessage).not.toHaveBeenCalled();
    dockerSetup.dispose();
  });

  it('counts a wsl that cannot run as not ready', async () => {
    const { dockerSetup } = setup(false, {
      platform: 'win32',
      wsl: () => {
        throw new Error('spawn wsl.exe ENOENT');
      },
    });
    dockerSetup.initialize();
    await flush();
    expect(contextCalls()).toContainEqual([DockerContextKeys.wslReady, false]);
    dockerSetup.dispose();
  });
});

describe('Docker setup commands (package.json)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: {
      commands: Array<{ command: string; title: string; category: string }>;
      menus: { commandPalette: Array<{ command: string; when: string }> };
    };
  };

  it('declares the buttons as commands, hidden in the Command Palette', () => {
    const commands = [Commands.dockerSetupInstallWsl, Commands.dockerSetupShow];
    for (const command of commands) {
      expect(manifest.contributes.commands.find((entry) => entry.command === command)?.category).toBe('Devspaces');
      expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' });
    }
    // Devspaces never installs Docker Desktop or Docker Engine on this computer, and starts no Docker from the setup.
    for (const gone of ['devspaces.dockerSetup.install', 'devspaces.dockerSetup.start']) {
      expect(manifest.contributes.commands.map((entry) => entry.command)).not.toContain(gone);
    }
  });

  it('packages the resources (icon, workspace helper, editor of the repository groups)', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((line) => line.trim());
    expect(ignore).toContain('!resources/**');
    for (const file of ['resources/icon.svg', 'resources/helper/Dockerfile', 'resources/groupsEditor/editor.js', 'resources/groupsEditor/editor.css']) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
