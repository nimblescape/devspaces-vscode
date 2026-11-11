// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbortError, type RunOptions, type RunResult } from '../ports';
import { LockTimeoutError } from '../storage/lockFolder';
import type { DownloadVmImageOptions, VmImagePin } from '../vm/vmImage';
import { WSL_LIST_ARGS } from './dockerHost';
import {
  DOCKER_WAIT_SCRIPT,
  LXSS_KEY,
  WSL_TERMINATE_ARGS,
  WSL_UNREGISTER_ARGS,
  WslSetup,
  WslSetupError,
  dockerDesktopIntegrates,
  dockerDesktopSettingsFiles,
  listsDistribution,
  parseLxss,
  distributionFoldersOf,
  parseWindowsArch,
  parseWslVersion,
  readWindowsArch,
  regDeleteDefaultArgs,
  regExportArgs,
  supportsFromFile,
  virtualMachineUnavailable,
  WINDOWS_ARCH_ARGS,
  wslInstallArgs,
  wslSetupFolder,
  type WslImage,
  type WslSetupStep,
} from './wslSetup';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const REG = 'C:\\Windows\\System32\\reg.exe';
const REPOSITORY = 'ghcr.io/nimblescape/devspaces-vm';
/** A pin of the image of the VM with a `.wsl` file for amd64 and arm64. */
const PIN: VmImagePin = {
  version: '13.20261109.1850',
  repository: REPOSITORY,
  files: {
    amd64: { wsl: { name: 'devspaces-vm-amd64.wsl', digest: `sha256:${'ab'.repeat(32)}`, size: 10 }, lima: { name: 'devspaces-vm-amd64.qcow2', digest: `sha256:${'ef'.repeat(32)}`, size: 20 } },
    arm64: { wsl: { name: 'devspaces-vm-arm64.wsl', digest: `sha256:${'cd'.repeat(32)}`, size: 11 } },
  },
};

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string, exitCode = 1): RunResult => ({ exitCode, stdout: '', stderr, timedOut: false });
const timedOut: RunResult = { exitCode: null, stdout: '', stderr: '', timedOut: true };
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

interface Call {
  file: string;
  args: readonly string[];
  options?: RunOptions;
}

/**
 * The file of `reg.exe export` with the distributions `folders` (name, then BasePath), in UTF-16 with a BOM, as Windows
 * writes it. `states`: the value State of a distribution by its name (none without).
 */
function lxssExport(folders: Record<string, string>, defaultIndex: number | 'none' = 1, states: Record<string, number> = {}): Buffer {
  const key = LXSS_KEY.replace('HKCU', 'HKEY_CURRENT_USER');
  const lines = ['Windows Registry Editor Version 5.00', '', `[${key}]`, ...(defaultIndex === 'none' ? [] : [`"DefaultDistribution"="{${defaultIndex}}"`]), ''];
  Object.entries(folders).forEach(([name, basePath], index) => {
    const escaped = basePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const state = states[name] === undefined ? [] : [`"State"=dword:${states[name].toString(16).padStart(8, '0')}`];
    lines.push(`[${key}\\{${index}}]`, `"BasePath"="${escaped}"`, `"DistributionName"="${name}"`, '"Flags"=dword:0000000f', ...state, '');
  });
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]);
}

const isRunResult = (value: Record<string, string> | RunResult): value is RunResult => typeof value.timedOut === 'boolean';

/**
 * A runner of `wsl.exe` that answers each call with `answer`; a call that `answer` does not know fails the test.
 * `reg.exe export` writes `registry` (the folders of the distributions by name), or ends with it when it is a result.
 */
function wslRunner(answer: (args: readonly string[], options?: RunOptions) => RunResult | Error | undefined, registry?: Record<string, string> | RunResult) {
  const calls: Call[] = [];
  return {
    calls,
    run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
      calls.push({ file, args, options });
      if (file === REG && registry !== undefined) {
        if (isRunResult(registry)) return registry;
        fs.writeFileSync(args[2], lxssExport(registry));
        return ok();
      }
      const result = answer(args, options);
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error(`unexpected wsl.exe ${args.join(' ')}`);
      return result;
    }),
  };
}

/** `runner`, with `reg.exe export` writing `lines` as they are (UTF-8): keys that lxssExport cannot write. */
function withRawRegistry<R extends ReturnType<typeof wslRunner>>(runner: R, lines: string[]): R {
  return {
    ...runner,
    run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
      if (file !== REG) return runner.run(file, args, options);
      fs.writeFileSync(args[2], Buffer.from(lines.join('\r\n'), 'utf8'));
      return ok();
    }),
  };
}

const isScript = (args: readonly string[]) => args.join(' ') === '-d devspaces -u root --cd / --exec sh -s';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-wsl-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

function setup(options: {
  runner: ReturnType<typeof wslRunner>;
  download?: (options: DownloadVmImageOptions) => Promise<unknown>;
  pin?: VmImagePin;
  arch?: string;
  wslPath?: string | undefined;
  log?: ReturnType<typeof logger>;
  stalledAfterMs?: number;
}): WslSetup {
  return new WslSetup({
    runner: options.runner,
    wslPath: () => ('wslPath' in options ? options.wslPath : WSL),
    env: { PATH: 'C:\\Windows\\System32' },
    arch: async () => options.arch ?? 'x64',
    folder,
    logger: options.log ?? logger(),
    download: options.download,
    pin: options.pin ?? PIN,
    stalledAfterMs: options.stalledAfterMs,
  });
}

describe('wslSetupFolder', () => {
  it('is a folder of nimblescape in LOCALAPPDATA, also with another case of the name', () => {
    expect(wslSetupFolder({ LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' })).toBe('C:\\Users\\Ana\\AppData\\Local\\nimblescape\\devspaces\\wsl');
    expect(wslSetupFolder({ LocalAppData: 'D:\\Local' })).toBe('D:\\Local\\nimblescape\\devspaces\\wsl');
    expect(wslSetupFolder({ APPDATA: 'C:\\Roaming' })).toBeUndefined();
    expect(wslSetupFolder({ LOCALAPPDATA: '' })).toBeUndefined();
  });
});

describe('wslInstallArgs', () => {
  it('registers the file under the name devspaces in the folder as WSL 2, without a start', () => {
    expect(wslInstallArgs('C:\\x\\debian.wsl', 'C:\\x\\disk')).toEqual([
      '--install',
      '--from-file',
      'C:\\x\\debian.wsl',
      '--name',
      'devspaces',
      '--location',
      'C:\\x\\disk',
      '--version',
      '2',
      '--no-launch',
    ]);
  });
});

describe('the version of WSL', () => {
  it('is read from the first line, also in another language and in UTF-16', () => {
    expect(parseWslVersion('WSL version: 2.4.4.0\r\nKernel version: 5.15.167.4-1\r\n')).toEqual([2, 4, 4]);
    expect(parseWslVersion('WSL-Version: 2.6.1.0\nKernelversion: 6.6.87.2-1\n')).toEqual([2, 6, 1]);
    expect(parseWslVersion('\uFEFFW\0S\0L\0 \0v\0e\0r\0s\0i\0o\0n\0:\0 \x002\0.\x005\0.\x0010\0')).toEqual([2, 5, 10]);
    expect(parseWslVersion('Usage: wsl.exe [Argument]')).toBeUndefined();
  });

  it('can register a file from 2.4.4 on', () => {
    expect(supportsFromFile([2, 4, 4])).toBe(true);
    expect(supportsFromFile([2, 5, 0])).toBe(true);
    expect(supportsFromFile([3, 0, 0])).toBe(true);
    expect(supportsFromFile([2, 4, 3])).toBe(false);
    expect(supportsFromFile([2, 3, 26])).toBe(false);
    expect(supportsFromFile([1, 9, 9])).toBe(false);
  });
});

describe('WslSetup.checkWsl', () => {
  it('gives the version of WSL, with WSL_UTF8=1', async () => {
    const runner = wslRunner((args) => (args[0] === '--version' ? ok('WSL version: 2.6.1.0\n') : undefined));
    await expect(setup({ runner }).checkWsl()).resolves.toBe('2.6.1');
    expect(runner.calls[0].file).toBe(WSL);
    expect(runner.calls[0].options?.env?.WSL_UTF8).toBe('1');
    expect(runner.calls[0].options?.timeoutMs).toBe(15_000);
  });

  it('refuses a WSL older than 2.4.4, also one that knows no --version', async () => {
    const old = wslRunner((args) => (args[0] === '--version' ? ok('WSL version: 2.3.26.0\n') : undefined));
    await expect(setup({ runner: old }).checkWsl()).rejects.toMatchObject({ problem: 'wslTooOld', message: expect.stringContaining('WSL 2.3.26 cannot register a file') });
    const inbox = wslRunner((args) => (args[0] === '--version' ? failed('Invalid command line argument: --version', 4294967295) : ok('Default Version: 2')));
    await expect(setup({ runner: inbox }).checkWsl()).rejects.toMatchObject({ problem: 'wslTooOld' });
  });

  it('says that WSL is missing without wsl.exe, when it cannot start, or when --status fails too', async () => {
    const none = wslRunner(() => undefined);
    await expect(setup({ runner: none, wslPath: undefined }).checkWsl()).rejects.toMatchObject({ problem: 'wslMissing' });
    expect(none.calls).toEqual([]);
    const notStarted = wslRunner(() => Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' }));
    await expect(setup({ runner: notStarted }).checkWsl()).rejects.toMatchObject({ problem: 'wslMissing' });
    // Another failure of the start is no missing WSL: a removal must not take it for one.
    const denied = wslRunner(() => Object.assign(new Error('spawn wsl.exe EACCES'), { code: 'EACCES' }));
    await expect(setup({ runner: denied }).registration()).rejects.toMatchObject({ problem: 'wslNotAnswering' });
    const stub = wslRunner(() => failed('The Windows Subsystem for Linux is not installed.'));
    await expect(setup({ runner: stub }).checkWsl()).rejects.toMatchObject({
      problem: 'wslMissing',
      message: expect.stringContaining('The Windows Subsystem for Linux is not installed.'),
    });
  });

  it('says that WSL does not answer when a short call ends by its time limit', async () => {
    const runner = wslRunner(() => timedOut);
    await expect(setup({ runner }).checkWsl()).rejects.toMatchObject({ problem: 'wslNotAnswering', message: 'wsl.exe --version did not answer within 15 seconds.' });
  });
});

describe('WslSetup.checkVirtualMachine', () => {
  it('fails with vmUnavailable when the status of WSL says that WSL 2 cannot start, in any language', async () => {
    const message = 'WSL2 kann nicht gestartet werden.\r\nWeitere Informationen finden Sie unter https://aka.ms/enablevirtualization';
    const runner = wslRunner((args) => (args[0] === '--status' ? ok(`Standardversion: 2\r\n${message}`) : undefined));
    await expect(setup({ runner }).checkVirtualMachine()).rejects.toMatchObject({ problem: 'vmUnavailable', message: expect.stringContaining('aka.ms/enablevirtualization') });
  });

  it('lets the setup go on when the status says nothing about it, or cannot be read', async () => {
    await expect(setup({ runner: wslRunner((args) => (args[0] === '--status' ? ok('Default Version: 2') : undefined)) }).checkVirtualMachine()).resolves.toBeUndefined();
    const log = logger();
    await expect(setup({ runner: wslRunner(() => timedOut), log }).checkVirtualMachine()).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('The status of WSL could not be read'));
  });

  it('is cancelled with the signal', async () => {
    const abort = new AbortController();
    const runner = wslRunner(() => {
      abort.abort();
      return new Error('aborted');
    });
    const error = await setup({ runner }).checkVirtualMachine(abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
  });
});

describe('virtualMachineUnavailable', () => {
  it('knows the error codes of WSL for a virtual machine that cannot start, and nothing else', () => {
    expect(virtualMachineUnavailable('Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE')).toBe(true);
    expect(virtualMachineUnavailable('Error code: Wsl/Service/CreateInstance/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED')).toBe(true);
    expect(virtualMachineUnavailable('WslRegisterDistribution failed with error: 0x80370102')).toBe(true);
    // UTF-16 output of an older WSL.
    expect(virtualMachineUnavailable('h\0t\0t\0p\0s\0:\0/\0/\0a\0k\0a\0.\0m\0s\0/\0e\0n\0a\0b\0l\0e\0v\0i\0r\0t\0u\0a\0l\0i\0z\0a\0t\0i\0o\0n\0')).toBe(true);
    expect(virtualMachineUnavailable('Error code: Wsl/Service/RegisterDistro/WSL_E_DISTRO_EXISTS')).toBe(false);
  });
});

describe('the architecture of Windows', () => {
  const answer = (stdout: string, exitCode = 0) => ({ run: vi.fn(async () => ({ exitCode, stdout, stderr: '', timedOut: false })) });

  it('comes from the registry, also for VS Code for x64 on Windows on Arm', async () => {
    const runner = answer('\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    PROCESSOR_ARCHITECTURE    REG_SZ    ARM64\r\n');
    const log = logger();
    await expect(readWindowsArch(runner, { SystemRoot: 'C:\\Windows' }, 'x64', log)).resolves.toBe('arm64');
    expect(runner.run).toHaveBeenCalledWith(REG, WINDOWS_ARCH_ARGS, { timeoutMs: 15_000 });
    expect(WINDOWS_ARCH_ARGS).toEqual(['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'PROCESSOR_ARCHITECTURE']);
    expect(log.info).toHaveBeenCalledWith('Windows runs on arm64, VS Code on x64: the WSL distribution of Devspaces gets the .wsl file for arm64.');
    expect(parseWindowsArch('    PROCESSOR_ARCHITECTURE    REG_SZ    AMD64')).toBe('x64');
    expect(parseWindowsArch('    PROCESSOR_ARCHITECTURE    REG_SZ    x86')).toBeUndefined();
  });

  it('is the architecture of VS Code when the registry does not tell it', async () => {
    await expect(readWindowsArch(answer('', 1), {}, 'x64', logger())).resolves.toBe('x64');
    await expect(readWindowsArch({ run: vi.fn(async () => Promise.reject(new Error('spawn reg.exe ENOENT'))) }, {}, 'arm64', logger())).resolves.toBe('arm64');
  });
});

// Mutation: a list that fails for another reason and counts as one without the distribution fails it (the setup would
// take a moment of a broken WSL for a distribution that is gone).
describe('listsDistribution', () => {
  const run = (exitCode: number, stdout: string, stderr = ''): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
  it('names the distribution without case; false without it, and when WSL has no distribution; undefined for another failure', () => {
    expect(listsDistribution(run(0, 'Ubuntu\r\nDevspaces\r\n'), 'devspaces')).toBe(true);
    expect(listsDistribution(run(0, 'Ubuntu\r\n'), 'devspaces')).toBe(false);
    expect(listsDistribution(run(1, 'Fehlercode: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND'), 'devspaces')).toBe(false);
    expect(listsDistribution(run(1, '', 'Error code: Wsl/Service/E_UNEXPECTED'), 'devspaces')).toBeUndefined();
  });
});

describe('WslSetup.registration', () => {
  it('is none without a distribution of that name, also when WSL lists none with an exit code', async () => {
    const noList = () => failed('Windows Subsystem for Linux has no installed distributions.', 4294967295);
    const empty = wslRunner(noList, failed('ERROR: The system was unable to find the specified registry key or value.'));
    await expect(setup({ runner: empty }).registration()).resolves.toBe('none');
    expect(empty.calls[0].args).toEqual(WSL_LIST_ARGS);
    await expect(setup({ runner: wslRunner(noList, { Ubuntu: 'C:\\WSL\\Ubuntu' }) }).registration()).resolves.toBe('none');
    // The code of WSL without any distribution needs no registry, in any language.
    const none = wslRunner(() => failed('Das Windows-Subsystem für Linux verfügt über keine installierten Distributionen.\r\nFehlercode: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND', 4294967295));
    await expect(setup({ runner: none }).registration()).resolves.toBe('none');
    expect(none.calls).toHaveLength(1);
    // A list without it needs no registry.
    const others = wslRunner(() => ok('Ubuntu\r\ndocker-desktop\r\n'));
    await expect(setup({ runner: others }).registration()).resolves.toBe('none');
    expect(others.calls).toHaveLength(1);
  });

  it('takes the registry when the list of WSL fails, so that a failed list does not hide the distribution', async () => {
    const runner = wslRunner(() => failed('Wsl/Service/E_UNEXPECTED'), { devspaces: path.join(folder, 'disk') });
    await expect(setup({ runner }).registration()).resolves.toBe('own');
  });

  it('is own when the registry names the folder of Devspaces for its virtual disk, else foreign (names without case)', async () => {
    const list = () => ok('Ubuntu\r\nDevspaces\r\n');
    const disk = path.join(folder, 'disk');
    const own = wslRunner(list, { Ubuntu: 'C:\\WSL\\Ubuntu', Devspaces: `\\\\?\\${disk.toUpperCase()}\\` });
    await expect(setup({ runner: own }).registration()).resolves.toBe('own');
    const reg = own.calls.find((call) => call.file === REG);
    expect(reg?.args).toEqual(regExportArgs(reg?.args[2] ?? ''));
    expect(reg?.args[2].startsWith(os.tmpdir())).toBe(true);
    // The export is removed after the read, and nothing is written to the folder of Devspaces.
    expect(fs.existsSync(path.dirname(reg?.args[2] ?? ''))).toBe(false);
    expect(fs.readdirSync(folder)).toEqual([]);
    // A distribution of the user with that name, also with a virtual disk in the folder of Devspaces.
    fs.mkdirSync(disk);
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), '');
    await expect(setup({ runner: wslRunner(list, { devspaces: 'D:\\mine' }) }).registration()).resolves.toBe('foreign');
    await expect(setup({ runner: wslRunner(list, { Ubuntu: disk }) }).registration()).resolves.toBe('foreign');
    // The disk of a later registration may be in another folder of Devspaces.
    await expect(setup({ runner: wslRunner(list, { devspaces: path.join(folder, 'disk-2') }) }).registration()).resolves.toBe('own');
    // The registry may name the folder in another form: through a link (or a junction, or a short name on Windows).
    const link = `${folder}-link`;
    fs.symlinkSync(folder, link);
    try {
      await expect(setup({ runner: wslRunner(list, { devspaces: path.join(link, 'disk') }) }).registration()).resolves.toBe('own');
    } finally {
      fs.rmSync(link);
    }
  });

  it('never guesses the owner when WSL lists the distribution but the registry cannot be read', async () => {
    const log = logger();
    fs.mkdirSync(path.join(folder, 'disk'));
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), '');
    const runner = wslRunner(() => ok('devspaces\r\n'), failed('ERROR: Registry editing has been disabled by your administrator.'));
    await expect(setup({ runner, log }).registration()).rejects.toMatchObject({ problem: 'registryFailed' });
    expect(log.warn).toHaveBeenCalledWith(
      `The WSL distributions could not be read from the registry (${LXSS_KEY}): reg.exe export ended with exit code 1: ERROR: Registry editing has been disabled by your administrator.`,
    );
  });

  it('is sure for a removal: it tells neither none nor own when neither the list nor the registry can be read', async () => {
    const runner = wslRunner((args) => (args[0] === '--version' ? ok('WSL version: 2.6.1.0') : failed('Wsl/Service/E_UNEXPECTED')), failed('ERROR: Access is denied.'));
    await expect(setup({ runner }).registration()).resolves.toBe('none');
    await expect(setup({ runner }).registration(undefined, true)).rejects.toMatchObject({ problem: 'registryFailed' });
    // Without WSL (the wsl.exe of Windows that only offers the installation), there is no distribution.
    const stub = wslRunner(() => failed('The Windows Subsystem for Linux is not installed.'), failed('ERROR: The system was unable to find the specified registry key or value.'));
    await expect(setup({ runner: stub }).registration(undefined, true)).resolves.toBe('none');
    expect(stub.calls.filter((call) => call.file === WSL).map((call) => call.args)).toEqual([WSL_LIST_ARGS, ['--version'], ['--status']]);
    // Without any distribution, WSL tells it by its code.
    const none = wslRunner(() => failed('Error code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND', 4294967295), failed('ERROR: Access is denied.'));
    await expect(setup({ runner: none }).registration(undefined, true)).resolves.toBe('none');
  });

  it('is foreign when the registry does not tell the folder of the distribution', async () => {
    const runner = withRawRegistry(wslRunner(() => ok('devspaces\r\n')), ['[HKEY_CURRENT_USER\\Lxss\\{1}]', '"DistributionName"="devspaces"']);
    await expect(setup({ runner }).registration()).resolves.toBe('foreign');
  });

  it('says that WSL does not answer instead of none when the list ends by its time limit', async () => {
    const runner = wslRunner(() => timedOut);
    await expect(setup({ runner }).registration()).rejects.toMatchObject({ problem: 'wslNotAnswering' });
  });
});

describe('the registry of the WSL distributions', () => {
  it('gives the distributions in their order with their keys, and the key of the default one', () => {
    const registry = parseLxss(lxssExport({ Ubuntu: 'C:\\u', devspaces: 'C:\\d' }));
    expect(registry).toEqual({
      defaultId: '{1}',
      distributions: [
        { id: '{0}', name: 'Ubuntu', basePath: 'C:\\u', installed: undefined },
        { id: '{1}', name: 'devspaces', basePath: 'C:\\d', installed: undefined },
      ],
    });
    const key = LXSS_KEY.replace('HKCU', 'HKEY_CURRENT_USER');
    const noDefault = [`[${key}]`, '"DefaultVersion"=dword:00000002', '', `[${key}\\{0ABC}]`, '"DistributionName"="Debian"'].join('\r\n');
    expect(parseLxss(Buffer.from(noDefault, 'utf8'))).toEqual({ defaultId: undefined, distributions: [{ id: '{0abc}', name: 'Debian', basePath: undefined, installed: undefined }] });
  });

  it('tells whether each distribution is installed (State 1), and nothing without a State', () => {
    const registry = parseLxss(lxssExport({ Ubuntu: 'C:\\u', Debian: 'C:\\d', Alpine: 'C:\\a' }, 0, { Ubuntu: 1, Debian: 3 }));
    expect(registry.distributions.map((distribution) => distribution.installed)).toEqual([true, false, undefined]);
  });

  it('gives the folder of each distribution by its name, from UTF-16 or UTF-8', () => {
    const exported = lxssExport({ Ubuntu: 'C:\\Users\\ana\\WSL "x"', Devspaces: 'C:\\Users\\ana\\AppData\\Local\\nimblescape\\devspaces\\wsl\\disk' });
    const expected = new Map([
      ['ubuntu', 'C:\\Users\\ana\\WSL "x"'],
      ['devspaces', 'C:\\Users\\ana\\AppData\\Local\\nimblescape\\devspaces\\wsl\\disk'],
    ]);
    expect(distributionFoldersOf(parseLxss(exported))).toEqual(expected);
    expect(distributionFoldersOf(parseLxss(Buffer.from(exported.subarray(2).toString('utf16le'), 'utf8')))).toEqual(expected);
  });

  it('skips a key without a name, and gives no folder for a name without a plain one', () => {
    const text = [
      '[HKEY_CURRENT_USER\\Lxss\\{1}]',
      '"DistributionName"="docker-desktop"',
      '',
      '[HKEY_CURRENT_USER\\Lxss\\{2}]',
      '"BasePath"="C:\\\\x"',
      '',
      '[HKEY_CURRENT_USER\\Lxss\\{3}]',
      '"BasePath"=hex(2):43,00,3a,00,00,00',
      '"DistributionName"="Other"',
    ].join('\r\n');
    expect(distributionFoldersOf(parseLxss(Buffer.from(text, 'utf8')))).toEqual(new Map([['docker-desktop', undefined], ['other', undefined]]));
  });
});

describe('WslSetup.separate', () => {
  /** A runner of `wsl.exe` whose `wsl --set-default <name>` ends with `setDefault(name)`. */
  function registryRunner(setDefault: (name: string) => RunResult = () => ok()) {
    return wslRunner((args) => (args[0] === '--set-default' ? setDefault(args[1]) : undefined));
  }

  /**
   * `runner`, with `reg.exe export` writing `folders` with the default `defaultIndex` and the values State `states`, and
   * any other `reg.exe` ending with `regResult`.
   */
  function withRegistry(
    runner: ReturnType<typeof wslRunner>,
    folders: Record<string, string>,
    defaultIndex: number | 'none',
    states: Record<string, number> = {},
    regResult: RunResult = ok(),
  ) {
    return {
      ...runner,
      run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
        if (file === REG && args[0] === 'export') {
          runner.calls.push({ file, args, options });
          fs.writeFileSync(args[2], lxssExport(folders, defaultIndex, states));
          return ok();
        }
        if (file === REG) {
          runner.calls.push({ file, args, options });
          return regResult;
        }
        return runner.run(file, args, options);
      }),
    };
  }

  const ours = () => path.join(folder, 'disk');

  // Mutation: a check without the default fails it (`wsl` in a terminal would open the distribution of Devspaces as
  // root, and Docker Desktop would integrate it); so does a default of Docker Desktop, or a change of a distribution
  // that Devspaces did not set up.
  it('makes the first other distribution of the user the default when WSL made the one of Devspaces the default', async () => {
    const base = registryRunner();
    const tools = { 'docker-desktop': 'C:\\dd', 'rancher-desktop': 'C:\\rd', 'podman-machine-default': 'C:\\pm' };
    const runner = withRegistry(base, { ...tools, Ubuntu: 'C:\\u', devspaces: ours() }, 4);
    const log = logger();
    // The registry also tells whether Docker Desktop has its distribution (its WSL integration needs it).
    await expect(setup({ runner, log }).separate()).resolves.toEqual({ state: 'separate', dockerDesktop: true });
    expect(base.calls.map((call) => call.args)).toEqual([expect.arrayContaining(['export']), ['--set-default', 'Ubuntu']]);
    expect(log.info).toHaveBeenCalledWith('The WSL distribution devspaces of Devspaces was the default distribution of WSL; now Ubuntu is.');
  });

  // Mutation: a stop after the first failure, or a try of a distribution that is not installed (WSL refuses it), fails it.
  it('skips a distribution that is not installed, and tries the next one after a failure', async () => {
    const base = registryRunner((name) => (name === 'Debian' ? failed('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND') : ok()));
    const folders = { Alpine: 'C:\\a', Debian: 'C:\\d', devspaces: ours(), Ubuntu: 'C:\\u' };
    const log = logger();
    await expect(setup({ runner: withRegistry(base, folders, 2, { Alpine: 3, Debian: 1 }), log }).separate()).resolves.toMatchObject({ state: 'separate' });
    expect(base.calls.map((call) => call.args).slice(1)).toEqual([
      ['--set-default', 'Debian'],
      ['--set-default', 'Ubuntu'],
    ]);
    expect(log.info).toHaveBeenCalledWith('The WSL distribution devspaces of Devspaces was the default distribution of WSL; now Ubuntu is.');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('removes the default of WSL when no other distribution of the user is there', async () => {
    const base = registryRunner();
    const runner = withRegistry(base, { 'docker-desktop': 'C:\\dd', 'docker-desktop-data': 'C:\\ddd', 'rancher-desktop-data': 'C:\\rdd', devspaces: ours() }, 3);
    await expect(setup({ runner }).separate()).resolves.toMatchObject({ state: 'separate' });
    expect(base.calls.map((call) => call.args)).toEqual([expect.arrayContaining(['export']), expect.arrayContaining(['export']), regDeleteDefaultArgs()]);
    expect(regDeleteDefaultArgs()).toEqual(['delete', LXSS_KEY, '/v', 'DefaultDistribution', '/f']);
  });

  it('changes nothing when another distribution is the default, or for a distribution that Devspaces did not set up', async () => {
    const base = registryRunner();
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 0) }).separate()).resolves.toEqual({ state: 'separate', dockerDesktop: false });
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 'none') }).separate()).resolves.toMatchObject({ state: 'separate' });
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: 'C:\\WSL\\devspaces' }, 1) }).separate()).resolves.toMatchObject({ state: 'none' });
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u' }, 0) }).separate()).resolves.toMatchObject({ state: 'none' });
    expect(base.calls.map((call) => call.args[0])).toEqual(['export', 'export', 'export', 'export']);
  });

  // Mutation: a stop after the refusals of `wsl --set-default` fails it; so does a wait for each distribution, or a
  // removal of the default, while WSL does not answer.
  it('removes the default of WSL when WSL refuses each other distribution, and not while WSL does not answer', async () => {
    const base = registryRunner(() => failed('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'));
    const log = logger();
    await expect(setup({ runner: withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 1), log }).separate()).resolves.toMatchObject({ state: 'separate' });
    expect(base.calls.map((call) => call.args[0])).toEqual(['export', '--set-default', 'export', 'delete']);
    expect(log.warn).not.toHaveBeenCalled();
    // WSL may only be slow: the user keeps a default, and the next check tries again.
    const silent = registryRunner(() => timedOut);
    await expect(setup({ runner: withRegistry(silent, { Ubuntu: 'C:\\u', Debian: 'C:\\d', devspaces: ours() }, 2) }).separate()).resolves.toMatchObject({ state: 'default' });
    expect(silent.calls.map((call) => call.args[0])).toEqual(['export', '--set-default']);
  });

  // Mutation: a removal without a second read fails it (it would remove a default that the user chose meanwhile).
  it('removes nothing when the default changed meanwhile', async () => {
    const base = registryRunner(() => failed('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'));
    let exports = 0;
    const runner = {
      ...base,
      run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions) => {
        if (file !== REG) return base.run(file, args, options);
        base.calls.push({ file, args, options });
        if (args[0] === 'export') fs.writeFileSync(args[2], lxssExport({ Ubuntu: 'C:\\u', devspaces: ours() }, exports++ === 0 ? 1 : 0));
        return ok();
      }),
    };
    await expect(setup({ runner }).separate()).resolves.toMatchObject({ state: 'separate' });
    expect(base.calls.map((call) => call.args[0])).toEqual(['export', '--set-default', 'export']);
  });

  it('runs nothing without the folder of Devspaces, and logs a failure without a throw', async () => {
    const base = registryRunner(() => failed('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'));
    const log = logger();
    const runner = withRegistry(base, { Ubuntu: 'C:\\u', devspaces: ours() }, 1, {}, failed('ERROR: Access is denied.'));
    await expect(setup({ runner, log }).separate()).resolves.toMatchObject({ state: 'default' });
    expect(log.warn).toHaveBeenCalledWith(
      'The WSL distribution devspaces of Devspaces stays the default distribution of WSL: wsl.exe --set-default Ubuntu ended with exit code 1: Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND; reg.exe delete ended with exit code 1: ERROR: Access is denied.',
    );
    const reg = registryRunner();
    const regLog = logger();
    await expect(setup({ runner: withRegistry(reg, { devspaces: ours() }, 0, {}, failed('ERROR: Access is denied.')), log: regLog }).separate()).resolves.toMatchObject({ state: 'default' });
    expect(regLog.warn).toHaveBeenCalledWith('The WSL distribution devspaces of Devspaces stays the default distribution of WSL: reg.exe delete ended with exit code 1: ERROR: Access is denied.');
    fs.rmSync(folder, { recursive: true, force: true });
    const none = registryRunner();
    await expect(setup({ runner: withRegistry(none, { devspaces: ours() }, 0) }).separate()).resolves.toMatchObject({ state: 'none' });
    expect(none.calls).toEqual([]);
  });

  it('tells when the registry cannot be read', async () => {
    const runner = wslRunner(() => undefined, failed('ERROR: The system was unable to find the specified registry key or value.'));
    await expect(setup({ runner }).separate()).resolves.toEqual({ state: 'unknown', dockerDesktop: undefined });
  });
});

describe('dockerDesktopIntegrates', () => {
  const env = { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' };
  const files = (content: Record<string, string>) => async (file: string) => {
    const text = content[path.win32.basename(file)];
    if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return text;
  };

  it('reads the list of the WSL integration of Docker Desktop, keys and names without case', async () => {
    expect(dockerDesktopSettingsFiles(env)).toEqual([
      'C:\\Users\\ana\\AppData\\Roaming\\Docker\\settings-store.json',
      'C:\\Users\\ana\\AppData\\Roaming\\Docker\\settings.json',
    ]);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":["Ubuntu","Devspaces"]}' }))).toBe(true);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings.json': '{"integratedWslDistros":["devspaces"]}' }))).toBe(true);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":["Ubuntu"],"EnableIntegrationWithDefaultWslDistro":true}' }))).toBe(false);
  });

  // Mutation: a check of the default integration also when the distribution is not the default, or without its default
  // (on), fails it.
  it('counts the integration with the default distribution of WSL only while the distribution is that default', async () => {
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({ 'settings-store.json': '{"IntegratedWslDistros":["Ubuntu"]}' }))).toBe(true);
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({ 'settings-store.json': '{"enableIntegrationWithDefaultWslDistro":false}' }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({}))).toBe(false);
  });

  // Mutation: a warning for the engine of Hyper-V fails it (it has no WSL integration).
  it('is false while Docker Desktop does not use its WSL 2 engine', async () => {
    expect(await dockerDesktopIntegrates(env, 'devspaces', true, files({ 'settings-store.json': '{"WslEngineEnabled":false,"IntegratedWslDistros":["devspaces"]}' }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings.json': '{"wslEngineEnabled":true,"integratedWslDistros":["devspaces"]}' }))).toBe(true);
  });

  // Mutation: a check of both files fails it (the file of an older version may stay after the move to settings-store.json);
  // so does a check of the older file while the new one is no JSON object (Docker Desktop may be writing it).
  it('reads only the first file that can be read', async () => {
    const stale = '{"IntegratedWslDistros":["devspaces"]}';
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":[]}', 'settings.json': stale }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"Integrated', 'settings.json': stale }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '[]', 'settings.json': stale }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings.json': stale }))).toBe(true);
  });

  it('is false without a file, with a file that is not JSON or has no list, and without APPDATA', async () => {
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({}))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{', 'settings.json': '[]' }))).toBe(false);
    expect(await dockerDesktopIntegrates(env, 'devspaces', false, files({ 'settings-store.json': '{"IntegratedWslDistros":"devspaces"}' }))).toBe(false);
    expect(await dockerDesktopIntegrates({}, 'devspaces', true, files({ 'settings-store.json': '{"IntegratedWslDistros":["devspaces"]}' }))).toBe(false);
  });
});

describe('WslSetup.image', () => {
  it('gives the .wsl file of the pin for the architecture of Windows, with the version and the repository, without a request', async () => {
    const runner = wslRunner(() => undefined);
    await expect(setup({ runner }).image()).resolves.toEqual({
      name: 'devspaces-vm-amd64.wsl',
      digest: `sha256:${'ab'.repeat(32)}`,
      size: 10,
      version: '13.20261109.1850',
      arch: 'x64',
      repository: REPOSITORY,
    });
    await expect(setup({ runner, arch: 'arm64' }).image()).resolves.toMatchObject({ name: 'devspaces-vm-arm64.wsl', size: 11, arch: 'arm64' });
    expect(runner.calls).toEqual([]);
  });

  it('fails with noImage for another architecture, and without a version of the image in the pin', async () => {
    const runner = wslRunner(() => undefined);
    await expect(setup({ runner, arch: 'ia32' }).image()).rejects.toMatchObject({
      problem: 'noImage',
      message: 'The image 13.20261109.1850 of the VM of Devspaces has no .wsl file for ia32.',
    });
    await expect(setup({ runner, pin: { version: null, repository: REPOSITORY, files: {} } }).image()).rejects.toMatchObject({
      problem: 'noImage',
      message: 'The image (none) of the VM of Devspaces has no .wsl file for x64.',
    });
    // A pin with only the disk for Lima.
    await expect(setup({ runner, pin: { ...PIN, files: { amd64: { lima: PIN.files.amd64?.lima } } } }).image()).rejects.toMatchObject({ problem: 'noImage' });
  });
});

describe('WslSetup.setUp', () => {
  const image: WslImage = { name: 'devspaces-vm-amd64.wsl', digest: `sha256:${'ab'.repeat(32)}`, size: 10, version: '13.20261109.1850', arch: 'x64', repository: REPOSITORY };
  /** The file of the download of `image` in the folder of Devspaces. */
  const downloaded = () => path.join(folder, 'download', image.name);

  /** A distribution that answers each step; `override` changes the answer of one; `registry` as in wslRunner. */
  function distribution(override: (args: readonly string[], options?: RunOptions) => RunResult | Error | undefined = () => undefined, registry?: Record<string, string> | RunResult) {
    return wslRunner((args, options) => {
      const own = override(args, options);
      if (own !== undefined) return own;
      if (args[0] === '--install') return ok('The operation completed successfully.');
      if (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT) return ok('29.9.2\n');
      return undefined;
    }, registry);
  }

  /** The calls of `wsl.exe` of `runner`, without those of `reg.exe`. */
  const wslCalls = (runner: { calls: Call[] }) => runner.calls.filter((call) => call.file === WSL);
  /** The calls of the script that waits for Docker. */
  const waits = (runner: { calls: Call[] }) => runner.calls.filter((call) => isScript(call.args) && call.options?.input === DOCKER_WAIT_SCRIPT);

  function writingDownload() {
    return vi.fn(async (options: DownloadVmImageOptions) => {
      options.onProgress?.(10, 10);
      fs.writeFileSync(options.target, 'distribution');
    });
  }

  it('downloads the .wsl file of the pin, registers it, and checks Docker at the first start, in this order', async () => {
    const runner = distribution();
    const download = writingDownload();
    const steps: WslSetupStep[] = [];
    const log = logger();
    await expect(setup({ runner, download, log }).setUp(image, (step) => steps.push(step))).resolves.toMatchObject({ version: '29.9.2' });
    const file = downloaded();
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ kind: 'wsl', arch: 'x64', target: file, pin: PIN, stalledAfterMs: undefined }));
    expect(log.info).toHaveBeenCalledWith(
      `The .wsl file of the image 13.20261109.1850 of the VM of Devspaces is downloaded from ${REPOSITORY} (devspaces-vm-amd64.wsl, 10 bytes, SHA-256 ${'ab'.repeat(32)}).`,
    );
    // After the registration, the registry tells whether WSL made the new distribution its default (WslSetup.separate).
    // No script sets up Docker, and the distribution does not restart: the image brings Docker and the settings of WSL.
    expect(runner.calls.map((call) => (call.file === REG ? call.args[0] : call.args))).toEqual([
      wslInstallArgs(file, path.join(folder, 'disk')),
      'export',
      ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-s'],
    ]);
    expect(runner.calls[0].args.join(' ')).toContain('--version 2 --no-launch');
    expect(runner.calls.filter((call) => call.file === WSL).every((call) => call.options?.env?.WSL_UTF8 === '1')).toBe(true);
    expect(waits(runner)[0].options?.timeoutMs).toBe(5 * 60_000);
    expect(steps).toEqual([{ kind: 'download', received: 0, total: 10 }, { kind: 'download', received: 10, total: 10 }, { kind: 'register' }, { kind: 'start' }]);
    // The download is gone after the registration; the folder of the disk stays.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(folder, 'disk'))).toBe(true);
  });

  it('passes the time without a byte to the download, and takes the size of the pin when the server tells none', async () => {
    const steps: WslSetupStep[] = [];
    const download = vi.fn(async (options: DownloadVmImageOptions) => {
      options.onProgress?.(4, undefined);
      fs.writeFileSync(options.target, 'distribution');
    });
    await setup({ runner: distribution(), download, stalledAfterMs: 20 }).setUp(image, (step) => steps.push(step));
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ stalledAfterMs: 20 }));
    expect(steps[1]).toEqual({ kind: 'download', received: 4, total: 10 });
  });

  it('fails with downloadFailed and registers nothing when the download fails', async () => {
    const runner = distribution();
    const download = vi.fn(async (options: DownloadVmImageOptions) => {
      fs.writeFileSync(options.target, 'part');
      throw new Error('The download of x received no bytes for 60 seconds.');
    });
    await expect(setup({ runner, download }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'downloadFailed',
      message: `The .wsl file of the VM of Devspaces could not be downloaded from ${REPOSITORY}: The download of x received no bytes for 60 seconds.`,
    });
    // Only the registry, for the folder of the disk.
    expect(wslCalls(runner)).toEqual([]);
    expect(fs.existsSync(downloaded())).toBe(false);
  });

  it('is cancelled with the signal during the download, and removes the download', async () => {
    const abort = new AbortController();
    const download = vi.fn(async (options: DownloadVmImageOptions) => {
      fs.writeFileSync(options.target, 'part');
      abort.abort();
      throw new Error('aborted');
    });
    const error = await setup({ runner: distribution(), download }).setUp(image, () => undefined, abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(fs.existsSync(downloaded())).toBe(false);
  });

  it('ends the registration after a cancel, keeps the distribution off the default of WSL, and does not start it', async () => {
    const abort = new AbortController();
    const runner = distribution(
      (args) => {
        if (args[0] === '--set-default') return ok();
        if (args[0] !== '--install') return undefined;
        abort.abort();
        return ok();
      },
      { Ubuntu: 'C:\\u', devspaces: path.join(folder, 'disk') },
    );
    const error = await setup({ runner, download: writingDownload() }).setUp(image, () => undefined, abort.signal).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(wslCalls(runner).map((call) => call.args[0])).toEqual(['--install', '--set-default']);
    expect(wslCalls(runner)[0].options?.signal).toBeUndefined();
    // WSL may have made the new distribution its default (WslSetup.separate, without the signal).
    const afterInstall = runner.calls.slice(runner.calls.findIndex((call) => call.args[0] === '--install') + 1);
    expect(afterInstall.map((call) => [call.args[0], call.options?.signal])).toEqual([
      ['export', undefined],
      ['--set-default', undefined],
    ]);
    expect(fs.existsSync(downloaded())).toBe(false);
  });

  it('fails with registerFailed with the message of WSL, and removes the download', async () => {
    const runner = distribution((args) => (args[0] === '--install' ? failed('W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0E\0X\0I\0S\0T\0S\0') : undefined));
    await expect(setup({ runner, download: writingDownload() }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'registerFailed',
      message: 'wsl.exe --install --from-file failed (exit code 1): WSL_E_DISTRO_EXISTS',
    });
    expect(wslCalls(runner)).toHaveLength(1);
    expect(fs.existsSync(downloaded())).toBe(false);
  });

  it('fails with vmUnavailable when WSL cannot start its virtual machine, and keeps the download for the next setup', async () => {
    const content = 'distribution';
    const checked = { ...image, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
    const hcs =
      'The operation could not be started because a required feature is not installed.\r\nError code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE';
    const broken = distribution((args) => (args[0] === '--install' ? failed(hcs, 4294967295) : undefined));
    const file = downloaded();
    await expect(setup({ runner: broken, download: writingDownload() }).setUp(checked, () => undefined)).rejects.toMatchObject({
      problem: 'vmUnavailable',
      message: expect.stringContaining(`HCS_E_SERVICE_NOT_AVAILABLE The download stays for the next setup: ${file}`),
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    // The next setup (after the restart) registers the file of the earlier one without a download, and then removes it.
    const runner = distribution();
    const download = writingDownload();
    const steps: WslSetupStep[] = [];
    const log = logger();
    await setup({ runner, download, log }).setUp(checked, (step) => steps.push(step));
    expect(download).not.toHaveBeenCalled();
    expect(steps.slice(0, 3)).toEqual([
      { kind: 'download', received: 0, total: checked.size },
      { kind: 'download', received: content.length, total: content.length },
      { kind: 'register' },
    ]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`The .wsl file of the VM of Devspaces of an earlier setup is used again: ${file}`));
    expect(wslCalls(runner)[0].args).toEqual(wslInstallArgs(file, path.join(folder, 'disk')));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('downloads again when the file of an earlier setup is not the file of the pin', async () => {
    fs.mkdirSync(path.join(folder, 'download'), { recursive: true });
    fs.writeFileSync(downloaded(), 'another file');
    const download = writingDownload();
    await setup({ runner: distribution(), download }).setUp(image, () => undefined);
    expect(download).toHaveBeenCalledTimes(1);
  });

  // Mutation: a setup that keeps the other files of the folder fails it (a download of 200 MB of another version would
  // stay there for good).
  it('removes the download of another version of the image or of an older Devspaces, and keeps its own', async () => {
    const downloads = path.join(folder, 'download');
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(downloads, 'debian.wsl'), 'of an older Devspaces');
    fs.writeFileSync(path.join(downloads, 'devspaces-vm-arm64.wsl'), 'of another architecture');
    const log = logger();
    const download = vi.fn(async (options: DownloadVmImageOptions) => {
      expect(fs.readdirSync(downloads)).toEqual([]);
      fs.writeFileSync(options.target, 'distribution');
    });
    await setup({ runner: distribution(), download, log }).setUp(image, () => undefined);
    expect(download).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(`The download ${path.join(downloads, 'debian.wsl')} of an earlier setup was removed.`);
    expect(fs.readdirSync(downloads)).toEqual([]);
  });

  it('fails with registerFailed, not vmUnavailable, when the registration ends by its time limit', async () => {
    const runner = distribution((args) => (args[0] === '--install' ? { ...timedOut, stderr: 'HCS_E_SERVICE_NOT_AVAILABLE' } : undefined));
    await expect(setup({ runner, download: writingDownload() }).setUp(image, () => undefined)).rejects.toMatchObject({ problem: 'registerFailed' });
    expect(fs.existsSync(downloaded())).toBe(false);
  });

  // Hannes's log on a slow virtual machine: Wsl/Service/CreateInstance/ERROR_TIMEOUT at the first start with systemd.
  it('starts the distribution again when WSL ran out of time to start it, at most three times', async () => {
    // wsl.exe writes its errors to the standard output.
    const timeout: RunResult = { exitCode: 4294967295, stdout: 'This operation returned because the timeout period expired. \r\nError code: Wsl/Service/CreateInstance/ERROR_TIMEOUT\r\n', stderr: '', timedOut: false };
    let starts = 0;
    const runner = distribution((args, options) => (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT && ++starts === 1 ? timeout : undefined));
    const log = logger();
    await expect(setup({ runner, log, download: writingDownload() }).setUp(image, () => undefined)).resolves.toMatchObject({ version: '29.9.2' });
    expect(starts).toBe(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('WSL ran out of time to start the distribution devspaces (attempt 1 of 3), so Devspaces starts it again: This operation returned'));
    // Three times, then the problem.
    const always = distribution((args, options) => (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT ? timeout : undefined));
    await expect(setup({ runner: always, download: writingDownload() }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'dockerNotRunning',
      message: expect.stringContaining('ERROR_TIMEOUT'),
    });
    expect(waits(always)).toHaveLength(3);
    // Another failure, or the time limit of the script itself, is not started again.
    for (const answer of [failed('systemd does not run in the distribution.'), timedOut]) {
      const other = distribution((args, options) => (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT ? answer : undefined));
      await expect(setup({ runner: other, download: writingDownload() }).setUp(image, () => undefined)).rejects.toMatchObject({ problem: 'dockerNotRunning' });
      expect(waits(other)).toHaveLength(1);
    }
  });

  it('fails with dockerNotRunning when Docker does not answer at the first start, with the reason of the script', async () => {
    const runner = distribution((args, options) => (isScript(args) && options?.input === DOCKER_WAIT_SCRIPT ? failed('systemd does not run in the distribution.') : undefined));
    await expect(setup({ runner, download: writingDownload() }).setUp(image, () => undefined)).rejects.toMatchObject({
      problem: 'dockerNotRunning',
      message: 'Docker does not answer at the first start of the WSL distribution devspaces (exit code 1): systemd does not run in the distribution.',
    });
  });

  it('removes the virtual disk of a setup that did not end before it registers the file again', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'old');
    const log = logger();
    const runner = distribution(undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await expect(setup({ runner, download: writingDownload(), log }).setUp(image, () => undefined)).resolves.toMatchObject({ version: '29.9.2' });
    expect(runner.calls.map((call) => call.file)).toEqual([REG, WSL, REG, WSL]);
    expect(fs.readdirSync(disk)).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(`The folder ${disk} has the files of a setup that did not end (ext4.vhdx); they are removed.`);
  });

  it('registers in another folder and removes nothing when a distribution uses the disk, or when nothing tells', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'in use');
    const log = logger();
    const used = distribution(undefined, { other: disk });
    await expect(setup({ runner: used, download: writingDownload(), log }).setUp(image, () => undefined)).resolves.toMatchObject({ version: '29.9.2' });
    const file = downloaded();
    expect(used.calls.find((call) => call.args[0] === '--install')?.args).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
    expect(log.info).toHaveBeenCalledWith(
      `The folder ${disk} has files (ext4.vhdx), and the WSL distribution other has its virtual disk there; the new distribution gets the folder ${path.join(folder, 'disk-2')}.`,
    );
    // Without the registry and the list of WSL, the next free folder.
    fs.writeFileSync(path.join(folder, 'disk-2', 'ext4.vhdx'), 'of the first one');
    const unknown = distribution(undefined, failed('Access is denied.'));
    await setup({ runner: unknown, download: writingDownload() }).setUp(image, () => undefined);
    expect(unknown.calls.find((call) => call.args[0] === '--install')?.args).toEqual(wslInstallArgs(file, path.join(folder, 'disk-3')));
    expect(fs.readdirSync(disk)).toEqual(['ext4.vhdx']);
    expect(fs.readdirSync(path.join(folder, 'disk-2'))).toEqual(['ext4.vhdx']);
  });

  it('keeps a disk folder that a known distribution uses, or that cannot be read', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'in use');
    const file = downloaded();
    const installArgs = (runner: ReturnType<typeof wslRunner>) => runner.calls.find((call) => call.args[0] === '--install')?.args;
    // A distribution with its disk there, next to one whose folder the registry does not tell.
    const mixed = withRawRegistry(distribution(), [
      '[HKEY_CURRENT_USER\\Lxss\\{1}]',
      `"BasePath"="${disk.replace(/\\/g, '\\\\')}"`,
      '"DistributionName"="other"',
      '',
      '[HKEY_CURRENT_USER\\Lxss\\{2}]',
      '"BasePath"=hex(2):43,00',
      '"DistributionName"="third"',
    ]);
    await setup({ runner: mixed, download: writingDownload() }).setUp(image, () => undefined);
    expect(installArgs(mixed)).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
    expect(fs.readdirSync(disk)).toEqual(['ext4.vhdx']);
    // A file in place of the folder.
    fs.rmSync(folder, { recursive: true });
    fs.mkdirSync(folder);
    fs.writeFileSync(disk, 'not a folder');
    const plain = distribution(undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await setup({ runner: plain, download: writingDownload() }).setUp(image, () => undefined);
    expect(installArgs(plain)).toEqual(wslInstallArgs(file, path.join(folder, 'disk-2')));
    expect(fs.readFileSync(disk, 'utf8')).toBe('not a folder');
  });

  it('registers in another folder when the files of a setup that did not end cannot be removed', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'open');
    const rm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (target === disk) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return rm(target, options);
    });
    try {
      const runner = distribution(undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
      const log = logger();
      await setup({ runner, download: writingDownload(), log }).setUp(image, () => undefined);
      expect(runner.calls.find((call) => call.args[0] === '--install')?.args).toEqual(wslInstallArgs(downloaded(), path.join(folder, 'disk-2')));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('and they could not be removed (EBUSY: resource busy or locked)'));
    } finally {
      spy.mockRestore();
    }
  });

  it('removes the virtual disk of a setup that did not end without the registry when WSL does not list the distribution', async () => {
    const disk = path.join(folder, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    fs.writeFileSync(path.join(disk, 'ext4.vhdx'), 'old');
    const runner = distribution((args) => (args.join(' ') === WSL_LIST_ARGS.join(' ') ? ok('Ubuntu\r\n') : undefined), failed('Access is denied.'));
    await expect(setup({ runner, download: writingDownload() }).setUp(image, () => undefined)).resolves.toMatchObject({ version: '29.9.2' });
    expect(fs.readdirSync(disk)).toEqual([]);
  });
});

describe('WslSetup.remove', () => {
  it('unregisters the distribution and removes the folder of Devspaces', async () => {
    fs.mkdirSync(path.join(folder, 'disk'));
    const runner = wslRunner((args) => (args.join(' ') === WSL_UNREGISTER_ARGS.join(' ') ? ok() : undefined), { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await setup({ runner }).remove();
    expect(runner.calls.map((call) => call.args[0])).toEqual([WSL_UNREGISTER_ARGS[0], 'export']);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps the folder of Devspaces when another distribution has its virtual disk there', async () => {
    fs.mkdirSync(path.join(folder, 'disk'));
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), 'other');
    const runner = wslRunner((args) => (args.join(' ') === WSL_UNREGISTER_ARGS.join(' ') ? ok() : undefined), { other: path.join(folder, 'disk') });
    await setup({ runner }).remove();
    expect(fs.readdirSync(path.join(folder, 'disk'))).toEqual(['ext4.vhdx']);
  });

  it('keeps the folder when WSL refuses', async () => {
    const runner = wslRunner(() => failed('Access is denied.'));
    await expect(setup({ runner }).remove()).rejects.toEqual(new WslSetupError('removeFailed', 'wsl.exe --unregister devspaces failed (exit code 1): Access is denied.'));
    expect(fs.existsSync(folder)).toBe(true);
  });
});

describe('WslSetup.stop', () => {
  it('terminates the distribution and deletes nothing', async () => {
    fs.mkdirSync(path.join(folder, 'disk'));
    const runner = wslRunner((args) => (args.join(' ') === WSL_TERMINATE_ARGS.join(' ') ? ok() : undefined));
    await setup({ runner }).stop();
    expect(runner.calls.map((call) => call.args.join(' '))).toEqual(['--terminate devspaces']);
    expect(fs.existsSync(path.join(folder, 'disk'))).toBe(true);
  });

  it('says why when WSL refuses', async () => {
    const runner = wslRunner(() => failed('Access is denied.'));
    await expect(setup({ runner }).stop()).rejects.toThrow('wsl.exe --terminate devspaces failed (exit code 1): Access is denied.');
  });
});

describe('WslSetup.locked', () => {
  it('runs one setup or removal at a time for all windows', async () => {
    let release: () => void = () => {};
    const first = setup({ runner: wslRunner(() => undefined) }).locked(() => new Promise<string>((resolve) => (release = () => resolve('first'))));
    // Until the first task holds the lock.
    await vi.waitFor(() => expect(fs.existsSync(`${folder}.lock`)).toBe(true));
    const task = vi.fn(async () => 'second');
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(task)).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toEqual({ value: 'first' });
    expect(fs.existsSync(`${folder}.lock`)).toBe(false);
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(task)).resolves.toEqual({ value: 'second' });
  });

  it('gives the failure of its task, also a lock time-out of the task itself', async () => {
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(async () => Promise.reject(new LockTimeoutError('other.lock')))).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(setup({ runner: wslRunner(() => undefined) }).locked(async () => Promise.reject(new Error('EACCES')))).rejects.toThrow('EACCES');
  });
});

describe('WslSetup.removeLeftovers', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(folder, 'disk'));
    fs.writeFileSync(path.join(folder, 'disk', 'ext4.vhdx'), 'old');
  });

  it('removes the folder of Devspaces when no WSL distribution has its virtual disk there', async () => {
    const runner = wslRunner(() => undefined, { Ubuntu: 'C:\\WSL\\Ubuntu' });
    await setup({ runner }).removeLeftovers();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('removes it without the registry when WSL lists no distribution devspaces', async () => {
    const runner = wslRunner(() => ok('Ubuntu\r\n'), failed('Access is denied.'));
    await setup({ runner }).removeLeftovers();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps it when the registry does not tell the folder of a distribution and WSL lists devspaces', async () => {
    const runner = withRawRegistry(wslRunner(() => ok('devspaces\r\n')), ['[HKEY_CURRENT_USER\\Lxss\\{1}]', '"DistributionName"="devspaces"', '"BasePath"=hex(2):43,00']);
    await setup({ runner }).removeLeftovers();
    expect(fs.readdirSync(path.join(folder, 'disk'))).toEqual(['ext4.vhdx']);
  });

  it('removes it without a key in the registry when WSL has no distribution', async () => {
    const noDistribution = failed('Windows Subsystem for Linux has no installed distributions.\r\nError code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND', 4294967295);
    const runner = wslRunner(() => noDistribution, failed('ERROR: The system was unable to find the specified registry key or value.'));
    await setup({ runner }).removeLeftovers();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('keeps it when a distribution has its disk there, when the registry does not tell, and does nothing without it', async () => {
    await setup({ runner: wslRunner(() => undefined, { other: path.join(folder, 'disk', 'other') }) }).removeLeftovers();
    await setup({ runner: wslRunner(() => undefined, failed('Access is denied.')) }).removeLeftovers();
    expect(fs.readdirSync(path.join(folder, 'disk'))).toEqual(['ext4.vhdx']);
    fs.rmSync(folder, { recursive: true });
    const runner = wslRunner(() => undefined);
    await setup({ runner }).removeLeftovers();
    expect(runner.calls).toEqual([]);
  });
});

describe('the script in the distribution', () => {
  it('is valid for sh', () => {
    const result = spawnSync('sh', ['-n'], { input: DOCKER_WAIT_SCRIPT, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
