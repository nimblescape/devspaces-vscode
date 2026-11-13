// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The uninstall hook (R-GEN-008): it removes the scheduled task, the own Docker context `devspaces`, and the folder of
// Devspaces outside of VS Code only when no VM of Devspaces is in it. It never deletes the VM, the WSL distribution or
// a devspace, and never contacts a Docker engine. `systemctl`, `launchctl`, `whoami` and `schtasks` are fakes; the home
// folder is a temporary folder. The last test runs the real bundle with Node.js.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packageBundleOptions, sharedBundleOptions } from '../../scripts/bundleOptions.mjs';
import { wslTaskName } from '../core/docker/wslTask';
import type { RunResult } from '../core/ports';
import { DOCKER_CONTEXT_DESCRIPTION, dockerContextFile } from '../core/vm/dockerContext';
import { VM_TASK_LABEL, vmTaskDefinitionFiles } from '../core/vm/vmTask';
import { consoleLogger, runUninstall, type UninstallDeps } from './main';

const ROOT = path.resolve(__dirname, '..', '..');
const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-uninstall-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const devspacesRoot = () => path.join(home, '.nimblescape', 'devspaces');
const dockerConfig = () => path.join(home, '.docker');
const contextFile = () => dockerContextFile(dockerConfig());
const ownContext = { Name: 'devspaces', Metadata: { Description: DOCKER_CONTEXT_DESCRIPTION }, Endpoints: { docker: { Host: 'unix:///x/docker.sock', SkipTLSVerify: false } } };

/** The files of Devspaces on macOS or Linux after a setup of the VM: Lima, the scheduled task, and the VM when `vm`. */
function macOrLinuxFiles(platform: 'darwin' | 'linux', options: { vm: boolean }): void {
  const root = devspacesRoot();
  write(path.join(root, 'lima', '2.2.1', 'bin', 'limactl'), '#!/bin/sh\n');
  write(path.join(root, 'vm', '_config', 'user'), 'key');
  write(path.join(root, 'task', 'vmTask.js'), '');
  write(path.join(root, 'task', 'task.json'), '{}');
  for (const file of vmTaskDefinitionFiles(platform, home)) write(file, 'definition');
  if (options.vm) write(path.join(root, 'vm', 'devspaces', 'lima.yaml'), 'vmType: vz\n');
}

function setUp(platform: NodeJS.Platform, answers: (file: string, args: readonly string[]) => RunResult | undefined = () => undefined) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const deps: UninstallDeps = {
    runner: {
      run: async (file, args) => {
        calls.push({ file, args });
        return answers(file, args) ?? ok();
      },
    },
    logger,
    platform,
    env: { PATH: '/usr/bin' },
    homeDir: home,
    uid: () => 501,
    wslFolder: path.join(home, 'AppData', 'Local', 'nimblescape', 'devspaces', 'wsl'),
  };
  const lines = () => [...logger.info.mock.calls, ...logger.warn.mock.calls].map(([text]) => String(text));
  return { deps, calls, logger, lines, run: () => runUninstall(deps) };
}

describe('the uninstall hook on Linux and macOS', () => {
  it('removes the systemd timer, the own Docker context, and the folder with Lima when no VM exists (Linux)', async () => {
    macOrLinuxFiles('linux', { vm: false });
    write(contextFile(), JSON.stringify(ownContext));
    write(path.join(dockerConfig(), 'contexts', 'tls', path.basename(path.dirname(contextFile())), 'docker', 'ca.pem'), 'x');
    const { calls, logger, run } = setUp('linux');
    await run();
    expect(calls.map(({ file, args }) => [file, ...args])).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'devspaces-vm.timer'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    for (const file of vmTaskDefinitionFiles('linux', home)) expect(fs.existsSync(file), file).toBe(false);
    expect(fs.existsSync(path.dirname(contextFile()))).toBe(false);
    expect(fs.readdirSync(path.join(dockerConfig(), 'contexts', 'tls'))).toEqual([]);
    expect(fs.existsSync(path.join(home, '.nimblescape'))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('removes the launch agent (macOS)', async () => {
    macOrLinuxFiles('darwin', { vm: false });
    const { calls, run } = setUp('darwin');
    await run();
    expect(calls.map(({ file, args }) => [file, ...args])).toEqual([['launchctl', 'bootout', `gui/501/${VM_TASK_LABEL}`]]);
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${VM_TASK_LABEL}.plist`))).toBe(false);
    expect(fs.existsSync(devspacesRoot())).toBe(false);
  });

  it('keeps the VM with Lima, and removes only the scheduled task, when the VM exists', async () => {
    macOrLinuxFiles('darwin', { vm: true });
    const { lines, run } = setUp('darwin');
    await run();
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${VM_TASK_LABEL}.plist`))).toBe(false);
    expect(fs.readdirSync(devspacesRoot()).sort()).toEqual(['lima', 'vm']);
    expect(fs.existsSync(path.join(devspacesRoot(), 'vm', 'devspaces', 'lima.yaml'))).toBe(true);
    expect(lines()).toContain(`The VM of Devspaces exists, so its folder ${devspacesRoot()} stays. The user guide says how to delete it (Uninstall).`);
  });

  it('keeps a VM that `limactl create` left half done', async () => {
    macOrLinuxFiles('linux', { vm: false });
    write(path.join(devspacesRoot(), 'vm', 'devspaces', 'diffdisk'), '');
    await setUp('linux').run();
    expect(fs.existsSync(path.join(devspacesRoot(), 'vm', 'devspaces', 'diffdisk'))).toBe(true);
    expect(fs.existsSync(path.join(devspacesRoot(), 'lima'))).toBe(true);
  });

  it('keeps the folder while another window sets up the VM', async () => {
    macOrLinuxFiles('linux', { vm: false });
    write(path.join(devspacesRoot(), 'vm-setup.lock', 'owner'), 'token of another window');
    const { lines, run } = setUp('linux');
    await run();
    expect(fs.existsSync(path.join(devspacesRoot(), 'lima'))).toBe(true);
    expect(lines()).toContain(`Another window sets up the VM of Devspaces now, so the folder ${devspacesRoot()} stays.`);
  });

  it('keeps the folder nimblescape when it holds more than the folder of Devspaces', async () => {
    macOrLinuxFiles('linux', { vm: false });
    write(path.join(home, '.nimblescape', 'other', 'file'), 'x');
    await setUp('linux').run();
    expect(fs.readdirSync(path.join(home, '.nimblescape'))).toEqual(['other']);
  });

  it('does nothing without files of Devspaces, and runs no program', async () => {
    const { calls, logger, run } = setUp('linux');
    await run();
    expect(calls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('the Docker context devspaces in the uninstall hook', () => {
  it('keeps a context devspaces that Devspaces did not create', async () => {
    const other = { ...ownContext, Metadata: { Description: 'my own context' } };
    write(contextFile(), JSON.stringify(other));
    const { lines, run } = setUp('linux');
    await run();
    expect(JSON.parse(fs.readFileSync(contextFile(), 'utf8'))).toEqual(other);
    expect(lines()).toContain('The Docker context devspaces was not created by Devspaces, so it stays.');
  });

  it('keeps its own context while it is the current one, or while config.json cannot be read, and says how to remove it', async () => {
    write(contextFile(), JSON.stringify(ownContext));
    for (const config of [JSON.stringify({ currentContext: 'devspaces' }), '{ not json']) {
      write(path.join(dockerConfig(), 'config.json'), config);
      const { logger, run } = setUp('linux');
      await run();
      expect(fs.existsSync(contextFile()), config).toBe(true);
      expect(String(logger.warn.mock.calls[0]?.[0])).toContain('"docker context use default" and then "docker context rm devspaces"');
    }
  });

  it('keeps its own context while DOCKER_CONTEXT names it', async () => {
    write(contextFile(), JSON.stringify(ownContext));
    const { deps, logger, run } = setUp('linux');
    deps.env = { ...deps.env, DOCKER_CONTEXT: 'devspaces' };
    await run();
    expect(fs.existsSync(contextFile())).toBe(true);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('is the current Docker context (DOCKER_CONTEXT');
  });

  it('removes its own context when config.json names another current context, and uses DOCKER_CONFIG', async () => {
    const config = path.join(home, 'docker-config');
    const file = dockerContextFile(config);
    write(file, JSON.stringify(ownContext));
    write(path.join(config, 'config.json'), JSON.stringify({ currentContext: 'desktop-linux', auths: {} }));
    const { deps, run } = setUp('linux');
    deps.env = { ...deps.env, DOCKER_CONFIG: config };
    await run();
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(config, 'config.json'), 'utf8'))).toEqual({ currentContext: 'desktop-linux', auths: {} });
  });
});

describe('the uninstall hook on Windows', () => {
  /** The files of Devspaces on Windows after a setup: the record of the task, and the distribution when `disk`. */
  function windowsFiles(deps: UninstallDeps, options: { disk: boolean }): string {
    const root = path.dirname(deps.wslFolder!);
    write(path.join(root, 'task', 'task.xml'), '<Task/>');
    write(path.join(deps.wslFolder!, 'download', 'devspaces-vm-x64.wsl'), 'image');
    if (options.disk) write(path.join(deps.wslFolder!, 'disk', 'ext4.vhdx'), 'disk');
    return root;
  }

  /** The export of the registry key of WSL with the distributions `folders` (name and BasePath), as `reg.exe export` writes it. */
  function registry(folders: Record<string, string>): string {
    const keys = Object.entries(folders).map(
      ([name, folder], index) => `[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{0000000${index}-0000-0000-0000-000000000000}]\r\n"DistributionName"="${name}"\r\n"BasePath"="${folder.replace(/\\/g, '\\\\')}"\r\n"State"=dword:00000001\r\n`,
    );
    return ['Windows Registry Editor Version 5.00\r\n', '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss]\r\n', ...keys].join('\r\n');
  }

  /** whoami names the SID; reg.exe writes the registry with `folders`; schtasks answers as `schtasks` says. */
  const windowsAnswers =
    (options: { folders?: Record<string, string>; schtasks?: (args: readonly string[]) => RunResult | undefined } = {}) =>
    (file: string, args: readonly string[]): RunResult | undefined => {
      if (file.endsWith('whoami.exe')) return ok(`"desktop\\ada","${SID}"\r\n`);
      if (file.endsWith('reg.exe') && args[0] === 'export') {
        write(args[2], registry(options.folders ?? {}));
        return ok();
      }
      if (file.endsWith('schtasks.exe')) return options.schtasks?.(args);
      return undefined;
    };

  const programs = (calls: { file: string; args: readonly string[] }[]) => calls.map(({ file, args }) => [path.win32.basename(file), ...(file.endsWith('reg.exe') ? [args[0]] : args)]);

  it('deletes the task of Task Scheduler and the folder of Devspaces when no distribution is in it', async () => {
    const { deps, calls, logger, run } = setUp('win32', windowsAnswers({ folders: { ubuntu: 'C:\\Users\\ada\\Ubuntu' } }));
    const root = windowsFiles(deps, { disk: false });
    await run();
    expect(programs(calls)).toEqual([
      ['whoami.exe', '/user', '/fo', 'csv', '/nh'],
      ['schtasks.exe', '/Query', '/TN', wslTaskName(SID)],
      ['schtasks.exe', '/Delete', '/TN', wslTaskName(SID), '/F'],
      ['reg.exe', 'export'],
    ]);
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(path.dirname(root))).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the WSL distribution and its folder, and deletes only the task', async () => {
    const { deps, lines, run } = setUp('win32', windowsAnswers());
    const root = windowsFiles(deps, { disk: true });
    await run();
    expect(fs.existsSync(path.join(root, 'task', 'task.xml'))).toBe(false);
    expect(fs.existsSync(path.join(deps.wslFolder!, 'disk', 'ext4.vhdx'))).toBe(true);
    expect(fs.existsSync(path.join(deps.wslFolder!, 'download', 'devspaces-vm-x64.wsl'))).toBe(true);
    expect(lines()).toContain(`The WSL distribution of Devspaces exists, so its folder ${root} stays. The user guide says how to delete it (Uninstall).`);
  });

  it('keeps the folder when the registry names a distribution with its disk there, also without a .vhdx file', async () => {
    const { deps, run } = setUp('win32', windowsAnswers({ folders: { devspaces: path.join(home, 'AppData', 'Local', 'nimblescape', 'devspaces', 'wsl', 'disk-2') } }));
    windowsFiles(deps, { disk: false });
    await run();
    expect(fs.existsSync(path.join(deps.wslFolder!, 'download', 'devspaces-vm-x64.wsl'))).toBe(true);
  });

  it('keeps the record of a task that it could not delete, so that a later install can delete the task', async () => {
    const { deps, logger, lines, run } = setUp('win32', windowsAnswers({ schtasks: (args) => (args[0] === '/Delete' ? failed('Access is denied.') : undefined) }));
    const root = windowsFiles(deps, { disk: false });
    await run();
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('The scheduled task of the WSL distribution of Devspaces could not be removed: schtasks /Delete ended with exit code 1: Access is denied.');
    expect(fs.readdirSync(root)).toEqual(['task']);
    expect(fs.existsSync(path.join(root, 'task', 'task.xml'))).toBe(true);
    expect(lines()).toContain(`Devspaces removed its files in ${root}; the folder stays, because it is not empty.`);
  });

  it('goes on with the other steps when the task cannot be read, and never throws', async () => {
    const answers = windowsAnswers();
    const { deps, logger, run } = setUp('win32', (file, args) => (file.endsWith('whoami.exe') ? failed('Access is denied.') : answers(file, args)));
    windowsFiles(deps, { disk: false });
    write(contextFile(), JSON.stringify(ownContext));
    await expect(run()).resolves.toBeUndefined();
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('The scheduled task of the WSL distribution of Devspaces could not be removed: whoami /user did not name the SID');
    expect(fs.existsSync(contextFile())).toBe(false);
    expect(fs.existsSync(path.join(deps.wslFolder!, 'download'))).toBe(false);
  });

  it('runs no program without the record of the task and without the folder', async () => {
    const { calls, run } = setUp('win32', windowsAnswers());
    await run();
    expect(calls).toEqual([]);
  });
});

describe('the log of the uninstall hook', () => {
  it('writes one line for each message, and an error on stderr', () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = consoleLogger(
      (text) => out.push(text),
      (text) => err.push(text),
    );
    logger.info('one');
    logger.warn('two');
    logger.error('three', new Error('why'));
    expect(out).toEqual(['INFO one\n', 'WARN two\n']);
    expect(err).toEqual(['ERROR three why\n']);
  });
});

describe('the bundle of the uninstall hook', () => {
  // As VS Code runs it: `node dist/uninstall.js --type=extension-post-uninstall`, with the home folder of the user. The
  // systemd of the user is a fake program in PATH that writes its arguments into a file.
  it.skipIf(process.platform !== 'linux')('removes the scheduled task and the folder of Devspaces when Node.js runs it', async () => {
    macOrLinuxFiles('linux', { vm: false });
    const bin = path.join(home, 'bin');
    const record = path.join(home, 'systemctl.log');
    write(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${record}'\n`);
    fs.chmodSync(path.join(bin, 'systemctl'), 0o755);
    const options = packageBundleOptions(sharedBundleOptions({ production: true })).find((bundle) => bundle.outfile === 'dist/uninstall.js');
    if (options === undefined) throw new Error('esbuild.mjs builds no dist/uninstall.js.');
    const program = path.join(home, 'uninstall.js');
    await esbuild.build({ ...options, absWorkingDir: ROOT, outfile: program, logLevel: 'silent' });
    const output = execFileSync(process.execPath, [program, '--type=extension-post-uninstall'], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
    });
    expect(output).toContain('INFO Devspaces removed its scheduled task');
    expect(fs.readFileSync(record, 'utf8')).toBe('--user disable --now devspaces-vm.timer\n--user daemon-reload\n');
    expect(fs.existsSync(path.join(home, '.nimblescape'))).toBe(false);
  }, 60_000);
});

describe('the paths of the uninstall hook', () => {
  it('removes nothing relative to the current folder when the home folder or LOCALAPPDATA is missing', async () => {
    const cwd = process.cwd();
    process.chdir(home);
    try {
      write(path.join(home, '.nimblescape', 'devspaces', 'lima', 'file'), 'x');
      write(path.join(home, 'nimblescape', 'devspaces', 'task', 'task.xml'), '<Task/>');
      for (const platform of ['linux', 'win32'] as const) {
        const { deps, calls, logger, run } = setUp(platform);
        deps.homeDir = '';
        deps.wslFolder = undefined;
        await run();
        expect(calls, platform).toEqual([]);
        const warnings = logger.warn.mock.calls.map(([text]) => String(text));
        expect(warnings[0], platform).toContain('the folder of the configuration of the Docker CLI is not an absolute path');
        if (platform === 'linux') expect(warnings[1]).toContain('the home folder "" is not an absolute path');
      }
      expect(fs.existsSync(path.join(home, '.nimblescape', 'devspaces', 'lima', 'file'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'nimblescape', 'devspaces', 'task', 'task.xml'))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
