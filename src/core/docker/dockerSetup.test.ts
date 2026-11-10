// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  DockerContextKeys,
  INITIAL_DOCKER_SETUP_STATE,
  INSTALL_WATCH_TIMEOUT_MS,
  changedContextValues,
  dockerContextValues,
  dockerSetupRequired,
  isHttpsUrlOf,
  keepWatchingInstall,
  needsMissingCliCheck,
  nextDockerSetupState,
  parseOsRelease,
  terminalLines,
  type DockerSetupEvent,
  type DockerSetupState,
  installTerminalOptions,
} from './dockerSetup';

describe('the install terminal', () => {
  const env = { PATH: '/workspace/evil/bin:/usr/bin', HOME: '/elsewhere', EVIL: '1', https_proxy: 'http://proxy:3128', LANG: 'de_AT.UTF-8' };

  it('uses /bin/sh, the home folder, and a fixed search path on Linux; keeps only the proxy and the language', () => {
    expect(installTerminalOptions('linux', env, '/home/octo', 'octo')).toEqual({
      shellPath: '/bin/sh',
      cwd: '/home/octo',
      strictEnv: true,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/home/octo',
        USER: 'octo',
        LOGNAME: 'octo',
        LANG: 'de_AT.UTF-8',
        https_proxy: 'http://proxy:3128',
      },
    });
  });

  it('uses the PowerShell of the system on Windows, in the home folder, with a fixed search path', () => {
    const hostEnv = {
      SystemRoot: 'D:\\Windows',
      // A folder of a repository first (for example of an activated virtual environment): never in the terminal.
      Path: 'C:\\repo\\.venv\\Scripts;D:\\Windows\\System32',
      LOCALAPPDATA: 'C:\\Users\\octo\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\octo',
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_PID: '42',
    };
    const options = installTerminalOptions('win32', hostEnv, 'C:\\Users\\octo', 'octo');
    expect(options).toEqual({
      shellPath: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      cwd: 'C:\\Users\\octo',
      strictEnv: true,
      env: {
        SystemRoot: 'D:\\Windows',
        USERPROFILE: 'C:\\Users\\octo',
        LOCALAPPDATA: 'C:\\Users\\octo\\AppData\\Local',
        PATH: 'D:\\Windows\\System32;D:\\Windows;D:\\Windows\\System32\\Wbem;D:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Users\\octo\\AppData\\Local\\Microsoft\\WindowsApps',
      },
    });
  });

  it('keeps a proxy and certificates of the computer, and nothing else', () => {
    const hostEnv = { HOMEBREW_CASK_OPTS: '--appdir=~/Applications', ALL_PROXY: 'socks5://p:1080', SSL_CERT_FILE: '/etc/ca.pem', OTHER: 'x' };
    const options = installTerminalOptions('linux', hostEnv, '/home/octo', 'octo');
    expect(options.env).toMatchObject({ ALL_PROXY: 'socks5://p:1080', SSL_CERT_FILE: '/etc/ca.pem' });
    expect(options.env.OTHER).toBeUndefined();
    expect(options.env.HOMEBREW_CASK_OPTS).toBeUndefined();
  });
});

describe('parseOsRelease', () => {
  it('reads plain, double-quoted, and single-quoted values, and skips comments and other lines', () => {
    const content = [
      '# comment',
      'NAME="Ubuntu"',
      'ID=ubuntu',
      "VERSION_CODENAME='noble'",
      'PRETTY_NAME="Ubuntu \\"24.04\\" LTS"',
      '',
      'not a field',
      'UBUNTU_CODENAME=noble\r',
    ].join('\n');
    expect(parseOsRelease(content)).toEqual({
      NAME: 'Ubuntu',
      ID: 'ubuntu',
      VERSION_CODENAME: 'noble',
      PRETTY_NAME: 'Ubuntu "24.04" LTS',
      UBUNTU_CODENAME: 'noble',
    });
  });

  it('gives an empty object for empty content', () => {
    expect(parseOsRelease('')).toEqual({});
  });
});

describe('isHttpsUrlOf (the host of a download)', () => {
  it.each<[string, boolean]>([
    ['https://download.docker.com/linux/static/stable/x86_64/docker-29.9.2.tgz', true],
    ['http://download.docker.com/linux/static/stable/x86_64/docker-29.9.2.tgz', false],
    ['https://download.docker.com.evil.example/docker.tgz', false],
    ['https://evil.example/download.docker.com/docker.tgz', false],
    ['https://user@download.docker.com/docker.tgz', true],
    ['https://download.docker.com:8443/docker.tgz', false],
    ['not a url', false],
  ])('%s is a URL of download.docker.com: %s', (url, expected) => {
    expect(isHttpsUrlOf(url, 'download.docker.com')).toBe(expected);
  });
});

describe('terminal lines', () => {
  it.each<[NodeJS.Platform, string[], string[]]>([
    ['darwin', ['a', 'b'], ['a && b']],
    ['linux', ['a', 'b', 'c'], ['a && b && c']],
    ['linux', ['a'], ['a']],
    ['linux', [], []],
    ['win32', ['a', 'b'], ['a', 'b']],
    ['win32', ['a'], ['a']],
  ])('%s %j', (platform, commands, expected) => {
    expect(terminalLines(commands, platform)).toEqual(expected);
  });
});

describe('context keys', () => {
  const state = (cliFound: boolean, engineRunning: boolean, wslReady = false): DockerSetupState => ({ cliFound, engineRunning, wslReady });

  it.each<[string, DockerSetupState, DockerSetupEvent, DockerSetupState]>([
    ['the CLI is found', state(false, false), { kind: 'cli', found: true }, state(true, false)],
    ['the CLI is still missing', state(false, false), { kind: 'cli', found: false }, state(false, false)],
    ['the CLI disappears: Docker cannot run', state(true, true), { kind: 'cli', found: false }, state(false, false)],
    ['the CLI is still there: the engine state stays', state(true, true), { kind: 'cli', found: true }, state(true, true)],
    ['docker info succeeds', state(true, false), { kind: 'engine', running: true }, state(true, true)],
    ['docker info fails', state(true, true), { kind: 'engine', running: false }, state(true, false)],
    ['docker info succeeds before the CLI check', state(false, false), { kind: 'engine', running: true }, state(true, true)],
    ['docker info fails without CLI', state(false, false), { kind: 'engine', running: false }, state(false, false)],
    ['WSL is ready', state(false, false), { kind: 'wsl', ready: true }, state(false, false, true)],
    ['WSL is not ready', state(true, true, true), { kind: 'wsl', ready: false }, state(true, true, false)],
  ])('%s', (_name, before, event, after) => {
    expect(nextDockerSetupState(before, event)).toEqual(after);
  });

  it.each<[DockerSetupState, Record<string, boolean>]>([
    [state(false, false), { missing: true, installed: false, ready: false, wslReady: false, setupRequired: true }],
    // A Docker of this computer never counts (R-ENG-001): without a Docker host of Devspaces, the setup shows.
    [state(true, false), { missing: false, installed: true, ready: false, wslReady: false, setupRequired: true }],
    [state(true, true, true), { missing: false, installed: true, ready: true, wslReady: true, setupRequired: true }],
    // Never ready without a CLI, also for an inconsistent state.
    [state(false, true), { missing: true, installed: false, ready: false, wslReady: false, setupRequired: true }],
  ])('values of %j', (value, expected) => {
    const values = dockerContextValues(value, false);
    expect({
      missing: values[DockerContextKeys.missing],
      installed: values[DockerContextKeys.installed],
      ready: values[DockerContextKeys.ready],
      wslReady: values[DockerContextKeys.wslReady],
      setupRequired: values[DockerContextKeys.setupRequired],
    }).toEqual(expected);
  });

  it('does not require the setup without a CLI when a Docker host of Devspaces is configured', () => {
    expect(dockerContextValues(state(false, false), true)[DockerContextKeys.setupRequired]).toBe(false);
    expect(dockerContextValues(state(false, false), true)[DockerContextKeys.missing]).toBe(true);
  });

  it('sets every key the first time, then only the keys that change', () => {
    const values = (value: DockerSetupState) => dockerContextValues(value, false);
    expect(changedContextValues(undefined, values(INITIAL_DOCKER_SETUP_STATE))).toEqual([
      [DockerContextKeys.missing, true],
      [DockerContextKeys.installed, false],
      [DockerContextKeys.ready, false],
      [DockerContextKeys.wslReady, false],
      [DockerContextKeys.setupRequired, true],
    ]);
    expect(changedContextValues(values(state(false, false)), values(state(false, false)))).toEqual([]);
    expect(changedContextValues(values(state(false, false)), values(state(true, false)))).toEqual([
      [DockerContextKeys.missing, false],
      [DockerContextKeys.installed, true],
    ]);
    expect(changedContextValues(values(state(true, false)), values(state(true, true)))).toEqual([[DockerContextKeys.ready, true]]);
  });

  it('uses the key names of package.json', () => {
    expect(DockerContextKeys).toEqual({
      missing: 'devspaces.dockerMissing',
      setupRequired: 'devspaces.dockerSetupRequired',
      installed: 'devspaces.dockerInstalled',
      ready: 'devspaces.dockerReady',
      wslReady: 'devspaces.wslReady',
    });
  });
});

describe('dockerSetupRequired', () => {
  // Without a Docker host of Devspaces (its own VM, or another host of its list), the sidebar shows the Docker setup in
  // place of the repositories, on every platform: Devspaces never uses the Docker of this computer (R-ENG-001).
  it('requires the setup exactly while Devspaces has no Docker host', () => {
    expect(dockerSetupRequired(false)).toBe(true);
    expect(dockerSetupRequired(true)).toBe(false);
    const dockerOfThisComputer: DockerSetupState = { cliFound: true, engineRunning: true, wslReady: true };
    expect(dockerContextValues(dockerOfThisComputer, false)[DockerContextKeys.setupRequired]).toBe(true);
  });
});

describe('checks of the CLI', () => {
  it('looks the CLI up every 10 s only while it is missing', () => {
    expect(needsMissingCliCheck({ ...INITIAL_DOCKER_SETUP_STATE, cliFound: false })).toBe(true);
    expect(needsMissingCliCheck({ ...INITIAL_DOCKER_SETUP_STATE, cliFound: true })).toBe(false);
  });

  it.each<[string, boolean, number, boolean]>([
    ['missing, just started', false, 0, true],
    ['missing, shortly before 30 minutes', false, INSTALL_WATCH_TIMEOUT_MS - 1, true],
    ['missing, after 30 minutes', false, INSTALL_WATCH_TIMEOUT_MS, false],
    ['found', true, 1000, false],
  ])('watches after an installation: %s', (_name, cliFound, elapsed, expected) => {
    expect(keepWatchingInstall({ ...INITIAL_DOCKER_SETUP_STATE, cliFound }, 1_000_000, 1_000_000 + elapsed)).toBe(expected);
  });

  it('watches 30 minutes at most', () => {
    expect(INSTALL_WATCH_TIMEOUT_MS).toBe(1_800_000);
  });
});
