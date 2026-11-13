// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The setup of the WSL distribution of Devspaces on Windows (docs/architecture.md "The WSL distribution of Devspaces",
// R-ENG-005): Devspaces downloads the `.wsl` file of the image of its VM (R-VM-002, src/core/vm/vmImage.ts) from ghcr.io
// for the architecture of Windows, checks it against the SHA-256 that its code pins, and registers it for the Windows
// user with `wsl --install --from-file` under the name `devspaces`, with its virtual disk in a folder of Devspaces. The
// image brings systemd, Docker Engine and the settings of WSL, so systemd starts Docker at the first start of the
// distribution; the VM upgrades its packages itself (R-VM-007). The removal is `wsl --unregister devspaces`. Whether
// Devspaces set up the distribution comes from the registry of the Windows user (the folder of its virtual disk). No
// `vscode`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from '../errors';
import { abortError, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { LockTimeoutError, withLockFolder } from '../storage/lockFolder';
import { errorCode } from '../storage/paths';
import { envValue } from './dockerCli';
import { WSL_DISTRIBUTION, WSL_LIST_ARGS, WSL_START_ATTEMPTS, parseWslList, wslCommandArgs, wslEnv, wslStartTimedOut, wslText } from './dockerHost';
import { downloadVmImage, VM_IMAGE_PIN, vmImageFile, type DownloadVmImageOptions, type VmImageFile, type VmImagePin } from '../vm/vmImage';

/** `wsl --install --from-file`, with `--name` and `--location`, needs WSL 2.4.4 or later. */
export const WSL_FROM_FILE_VERSION: readonly [number, number, number] = [2, 4, 4];
export const WSL_VERSION_ARGS: readonly string[] = ['--version'];
export const WSL_STATUS_ARGS: readonly string[] = ['--status'];
/** Deletes the distribution with its virtual disk: everything in it is lost. */
export const WSL_UNREGISTER_ARGS: readonly string[] = ['--unregister', WSL_DISTRIBUTION];
/** Stops the distribution with everything that runs in it; nothing is deleted, and its next use starts it again. */
export const WSL_TERMINATE_ARGS: readonly string[] = ['--terminate', WSL_DISTRIBUTION];
/** The key of the registry with the WSL distributions of the Windows user: one subkey for each, with its name and folder. */
export const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

/** The code in the answer of `wsl.exe --list` without any distribution (its text is in the language of Windows). */
const NO_DISTRIBUTIONS = /WSL_E_DEFAULT_DISTRO_NOT_FOUND/;
const SHORT_CALL_MS = 15_000;
const REGISTER_MS = 15 * 60_000;
/**
 * The first start of the distribution and the script that waits for Docker (DOCKER_WAIT_SCRIPT): the script ends within
 * about 4 minutes (180 seconds of waits, then calls with their own limits), so a failure still gives its reason.
 */
const START_MS = 5 * 60_000;
const UNREGISTER_MS = 5 * 60_000;
const TERMINATE_MS = 2 * 60_000;
/**
 * Marks in the output of `wsl.exe` when WSL 2 cannot start its virtual machine, because the Virtual Machine Platform of
 * Windows does not run: Windows has not restarted since the installation of WSL, the platform is off, or virtualization
 * is off in the firmware of the computer or, in a virtual machine, nested virtualization is off. They are the same in
 * every language: the error codes of WSL (`Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE`), the
 * code of older WSL versions (0x80370102, HCS_E_HYPERV_NOT_INSTALLED), and the address in the message of
 * `wsl.exe --status` when the service of the platform is missing (WslClient.cpp of WSL).
 */
const VM_UNAVAILABLE_MARKS = ['HCS_E_SERVICE_NOT_AVAILABLE', 'HCS_E_HYPERV_NOT_INSTALLED', '0x80370102', 'aka.ms/enablevirtualization'];
/** The value of the registry with the architecture of Windows itself (readWindowsArch). */
const ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
/** The file of `reg.exe export`, in a new folder of the temporary folder that is removed after the read. */
const REGISTRY_EXPORT_NAME = 'distributions.reg';
/**
 * The lock of the setup for all windows (withLockFolder): its holder refreshes it every 15 seconds, so that a lock
 * older than a minute is of a window that ended; another window waits for it one second. After the computer slept for
 * more than a minute, another window can take it before the holder refreshes it; then the script in the distribution
 * still runs only once at a time (flock), and WSL registers the name only once.
 */
const LOCK_TIMINGS = { staleMs: 60_000, timeoutMs: 1_000 };
/** The folders `disk-2` and so on that a new registration may take when `disk` has files of unknown use. */
const MAX_DISK_FOLDERS = 20;

/**
 * The folder of the WSL distribution of Devspaces: `%LOCALAPPDATA%\nimblescape\devspaces\wsl`, outside of the storage
 * of VS Code (which is in the roaming profile), so that the virtual disk stays on this computer. Undefined without
 * LOCALAPPDATA.
 */
export function wslSetupFolder(env: NodeJS.ProcessEnv): string | undefined {
  const localAppData = envValue(env, 'LOCALAPPDATA', 'win32');
  return localAppData ? path.win32.join(localAppData, 'nimblescape', 'devspaces', 'wsl') : undefined;
}

/**
 * The lock folder of the setup of the WSL distribution for all windows of the Windows user, which the uninstall hook
 * takes as well (src/uninstall/main.ts): `<folder>.lock`, next to the folder of the distribution.
 */
export function wslSetupLockFolder(folder: string): string {
  return `${folder}.lock`;
}

/**
 * The arguments of `wsl.exe` that register the file `file` as the distribution `devspaces` of WSL 2 (also when the
 * default of the user is WSL 1, which has no systemd), without a start.
 */
export function wslInstallArgs(file: string, location: string): string[] {
  return ['--install', '--from-file', file, '--name', WSL_DISTRIBUTION, '--location', location, '--version', '2', '--no-launch'];
}

/**
 * The `.wsl` file of the image of the VM of Devspaces for the architecture of Windows (vmImageFile): its name, digest
 * and size in the pin, with the version of the image. The file in the folder `download` has its name; it is removed
 * after the registration, and it stays only when WSL could not start its virtual machine (`vmUnavailable`), for the
 * next setup.
 */
export interface WslImage extends VmImageFile {
  version: string;
  /** The architecture of Windows (`x64` or `arm64`) that the file is for. */
  arch: string;
  /** The repository of the pin, for the log: `ghcr.io/nimblescape/devspaces-vm`. */
  repository: string;
}

/** True when `wsl.exe` ended because WSL ran out of time to start the distribution (wslStartTimedOut). */
export function startTimedOut(result: RunResult): boolean {
  return result.exitCode !== 0 && wslStartTimedOut(`${result.stdout}\n${result.stderr}`);
}

/** True when the output of `wsl.exe` says that WSL 2 cannot start its virtual machine (VM_UNAVAILABLE_MARKS). */
export function virtualMachineUnavailable(output: string): boolean {
  const text = wslText(output).toLowerCase();
  return VM_UNAVAILABLE_MARKS.some((mark) => text.includes(mark.toLowerCase()));
}

/** The arguments of `reg.exe` that read the architecture of Windows (parseWindowsArch). */
export const WINDOWS_ARCH_ARGS: readonly string[] = ['query', ENVIRONMENT_KEY, '/v', 'PROCESSOR_ARCHITECTURE'];

/**
 * The architecture of Windows in the output of `reg.exe query` (WINDOWS_ARCH_ARGS), as `process.arch` names it: `arm64`
 * or `x64`; undefined for another one or another output.
 */
export function parseWindowsArch(output: string): string | undefined {
  const value = /PROCESSOR_ARCHITECTURE\s+REG_(?:EXPAND_)?SZ\s+(\S+)/i.exec(output)?.[1].toUpperCase();
  return value === 'ARM64' ? 'arm64' : value === 'AMD64' ? 'x64' : undefined;
}

/**
 * The architecture of Windows itself, for the `.wsl` file of the WSL distribution, whose programs must run in WSL:
 * `process.arch` of VS Code is `x64` also for VS Code for x64 in the emulation of Windows on Arm, but the registry has the
 * architecture of Windows. `fallback` (`process.arch`) when the registry does not tell it (logged). Never throws.
 */
export async function readWindowsArch(runner: ProcessRunner, env: NodeJS.ProcessEnv, fallback: string, logger: Logger): Promise<string> {
  try {
    const result = await runner.run(regExePath(env), WINDOWS_ARCH_ARGS, { timeoutMs: SHORT_CALL_MS });
    const arch = result.exitCode === 0 ? parseWindowsArch(result.stdout) : undefined;
    if (arch !== undefined) {
      if (arch !== fallback) logger.info(`Windows runs on ${arch}, VS Code on ${fallback}: the WSL distribution of Devspaces gets the .wsl file for ${arch}.`);
      return arch;
    }
    logger.info(`The registry does not tell the architecture of Windows (${result.timedOut ? 'no answer' : `exit code ${result.exitCode}`}): the .wsl file for ${fallback} is used.`);
  } catch (error) {
    logger.info(`The registry does not tell the architecture of Windows (${errorMessage(error)}): the .wsl file for ${fallback} is used.`);
  }
  return fallback;
}

/** The version of WSL in the output of `wsl.exe --version` (its first line, also in other languages), or undefined. */
export function parseWslVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(wslText(output));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True when `version` is WSL_FROM_FILE_VERSION or later. */
export function supportsFromFile(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (version[index] !== WSL_FROM_FILE_VERSION[index]) return version[index] > WSL_FROM_FILE_VERSION[index];
  }
  return true;
}

/**
 * Whether the result of `wsl.exe --list --quiet` (WSL_LIST_ARGS) names the distribution `distribution` (without case):
 * false also when WSL has no distribution (NO_DISTRIBUTIONS); undefined when the list ends with another exit code
 * that is not 0.
 */
export function listsDistribution(result: RunResult, distribution: string): boolean | undefined {
  if (result.exitCode !== 0) return NO_DISTRIBUTIONS.test(wslText(`${result.stdout}\n${result.stderr}`)) ? false : undefined;
  return parseWslList(result.stdout).some((name) => name.toLowerCase() === distribution.toLowerCase());
}

/** `reg.exe` in System32 of SystemRoot, not from PATH. */
export function regExePath(env: NodeJS.ProcessEnv): string {
  const systemRoot = envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'reg.exe');
}

/** The arguments of `reg.exe` that write the key LXSS_KEY to `file` (a `.reg` file in UTF-16). */
export function regExportArgs(file: string): string[] {
  return ['export', LXSS_KEY, file, '/y'];
}

/** The value of LXSS_KEY that names the default distribution of WSL by its key (DistributionRegistration.cpp of WSL). */
export const LXSS_DEFAULT_VALUE = 'DefaultDistribution';

/** The arguments of `reg.exe` that delete the default distribution of WSL (LXSS_DEFAULT_VALUE): then WSL has none. */
export function regDeleteDefaultArgs(): string[] {
  return ['delete', LXSS_KEY, '/v', LXSS_DEFAULT_VALUE, '/f'];
}

/** The arguments of `wsl.exe` that make the distribution `name` the default distribution of WSL. */
export function wslSetDefaultArgs(name: string): string[] {
  return ['--set-default', name];
}

/** A WSL distribution in the registry (LXSS_KEY). */
export interface LxssDistribution {
  /** Its key, a GUID in braces, in lower case. */
  id: string;
  /** DistributionName. */
  name: string;
  /** BasePath, the folder of its virtual disk; undefined when it is missing or not a plain string. */
  basePath: string | undefined;
  /** Whether its State is LxssDistributionStateInstalled (1, wslservice.idl of WSL); undefined without a State. */
  installed: boolean | undefined;
}

/** The WSL distributions of the registry, in its order, and the key of the default one (lower case), when it has one. */
export interface LxssRegistry {
  defaultId: string | undefined;
  distributions: LxssDistribution[];
}

/**
 * The WSL distributions and the default one, from the file of `reg.exe export` of LXSS_KEY (UTF-16 with a BOM, else
 * UTF-8). A key without DistributionName is no distribution.
 */
export function parseLxss(content: Buffer): LxssRegistry {
  const text = content[0] === 0xff && content[1] === 0xfe ? content.subarray(2).toString('utf16le') : content.toString('utf8');
  const registry: LxssRegistry = { defaultId: undefined, distributions: [] };
  let key = '';
  let values = new Map<string, string>();
  let state: number | undefined;
  const close = (): void => {
    const name = values.get('distributionname');
    if (/\\lxss$/i.test(key)) registry.defaultId = values.get(LXSS_DEFAULT_VALUE.toLowerCase())?.toLowerCase();
    else if (name !== undefined) {
      const id = key.slice(key.lastIndexOf('\\') + 1).toLowerCase();
      registry.distributions.push({ id, name, basePath: values.get('basepath'), installed: state === undefined ? undefined : state === 1 });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      close();
      key = line.trim().replace(/^\[|\]$/g, '');
      values = new Map();
      state = undefined;
      continue;
    }
    // A string value: "Name"="Value", with \\ and \" inside.
    const match = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (match) values.set(unescapeRegistry(match[1]).toLowerCase(), unescapeRegistry(match[2]));
    const dword = /^"State"=dword:([0-9a-f]{8})$/i.exec(line.trim());
    if (dword) state = parseInt(dword[1], 16);
  }
  close();
  return registry;
}

/**
 * The folders of the WSL distributions of `registry` (the value BasePath: the folder of the virtual disk) by their name
 * in lower case (DistributionName). Undefined for a distribution whose BasePath is missing or not a plain string: its
 * folder is not known.
 */
export function distributionFoldersOf(registry: LxssRegistry): Map<string, string | undefined> {
  return new Map(registry.distributions.map((distribution) => [distribution.name.toLowerCase(), distribution.basePath]));
}

/** What WslSetup.separate found. */
export interface WslSeparation {
  /**
   * `none`, no distribution of Devspaces (or no folder of Devspaces); `unknown`, the registry cannot be read; `default`,
   * the distribution of Devspaces stays the default of WSL (its change failed); `separate`, it is not the default.
   */
  state: 'none' | 'unknown' | 'default' | 'separate';
  /**
   * Whether the registry has a distribution of Docker Desktop, which its WSL 2 engine and so its WSL integration need;
   * undefined when the registry cannot be read.
   */
  dockerDesktop: boolean | undefined;
}

/** The distributions of Docker Desktop (`docker-desktop`, and `docker-desktop-data` of older versions). */
function isDockerDesktopDistribution(name: string): boolean {
  return /^docker-desktop(-data)?$/i.test(name);
}

/**
 * The distributions that tools run as their machine, which must not be the default distribution of WSL in place of
 * the one of Devspaces: Docker Desktop, Rancher Desktop (`rancher-desktop`, `rancher-desktop-data`) and Podman
 * (`podman-machine-<name>`).
 */
function isToolDistribution(name: string): boolean {
  return isDockerDesktopDistribution(name) || /^rancher-desktop(-data)?$/i.test(name) || /^podman-machine-/i.test(name);
}

/**
 * The settings files of Docker Desktop on Windows: `settings-store.json`, and `settings.json` of older versions, in
 * `%APPDATA%\Docker` (docs.docker.com, "Change your Docker Desktop settings"). Empty without APPDATA.
 */
export function dockerDesktopSettingsFiles(env: NodeJS.ProcessEnv): string[] {
  const appData = envValue(env, 'APPDATA', 'win32');
  return appData ? ['settings-store.json', 'settings.json'].map((name) => path.win32.join(appData, 'Docker', name)) : [];
}

/**
 * Whether Docker Desktop has its WSL integration on for `distribution`: it is in the list IntegratedWslDistros, or it
 * is the default distribution of WSL (`isDefault`) while EnableIntegrationWithDefaultWslDistro is not false (on by
 * default); never while WslEngineEnabled is false (the engine of Hyper-V has no WSL integration). Keys and names
 * without case. The first settings file that can be read decides (the file of an older version may stay after the
 * move to settings-store.json); false when it is no JSON object, or when none can be read. Never rejects.
 */
export async function dockerDesktopIntegrates(
  env: NodeJS.ProcessEnv,
  distribution: string,
  isDefault: boolean,
  readFile: (file: string) => Promise<string> = (file) => fs.promises.readFile(file, 'utf8'),
): Promise<boolean> {
  for (const file of dockerDesktopSettingsFiles(env)) {
    let text: string;
    try {
      text = await readFile(file);
    } catch {
      continue;
    }
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      // Docker Desktop may be writing it; the file of an older version would tell old settings.
      return false;
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return false;
    const value = (name: string): unknown => Object.entries(settings).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (value('WslEngineEnabled') === false) return false;
    const list = value('IntegratedWslDistros');
    if (Array.isArray(list) && list.some((name) => typeof name === 'string' && name.toLowerCase() === distribution.toLowerCase())) return true;
    return isDefault && value('EnableIntegrationWithDefaultWslDistro') !== false;
  }
  return false;
}

function unescapeRegistry(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/** Whether the Windows path `folder` is `parent` or inside it: without case, without `\\?\` and closing separators. */
function isWithin(folder: string, parent: string): boolean {
  const plain = (name: string): string => path.win32.normalize(withoutLongPrefix(name)).replace(/[\\/]+$/, '').toLowerCase();
  return plain(folder) === plain(parent) || plain(folder).startsWith(`${plain(parent)}\\`);
}

function withoutLongPrefix(name: string): string {
  return name.replace(/^\\\\\?\\/, '');
}

/**
 * isWithin, also after links, junctions and short names are resolved (realpath), when both folders exist: the
 * registry may name the folder of a virtual disk in another form than LOCALAPPDATA.
 */
async function isWithinResolved(folder: string, parent: string): Promise<boolean> {
  if (isWithin(folder, parent)) return true;
  const resolve = (name: string): Promise<string | undefined> => fs.promises.realpath(withoutLongPrefix(name)).catch(() => undefined);
  const [realFolder, realParent] = await Promise.all([resolve(folder), resolve(parent)]);
  return realFolder !== undefined && realParent !== undefined && isWithin(realFolder, realParent);
}

/**
 * The script that waits up to 180 seconds for Docker at the first start of the distribution (`sh -s`, as root): in a
 * slow virtual machine, Docker needs about 45 seconds to start, after the start of the distribution. Each `docker
 * info` waits for the start of Docker (the socket of systemd), at most 30 seconds, and every other command has a limit
 * too, so that a start that hangs still ends the script with its reason within about 4 minutes, before START_MS.
 * Standard output: the version of the engine. On a failure, standard error gets the answer of `docker info` and the
 * state of the service.
 */
export const DOCKER_WAIT_SCRIPT = `end=$(($(date +%s) + 180))
until timeout 30 docker info > /dev/null 2>&1; do
if [ "$(date +%s)" -ge "$end" ]; then
[ -d /run/systemd/system ] || echo "systemd does not run in the distribution." >&2
timeout 10 docker info > /dev/null 2>&1 || timeout 10 docker info 2>&1 | tail -n 5 >&2
timeout 10 systemctl --no-pager status docker.service 2>&1 | tail -n 20 >&2
exit 1
fi
sleep 2
done
timeout 30 docker version --format '{{.Server.Version}}'
`;

export type WslSetupProblem =
  /** No `wsl.exe`, or WSL is not installed. */
  | 'wslMissing'
  /** `wsl.exe` did not answer a short call (its version, its list), or could not start for another reason than a missing file. */
  | 'wslNotAnswering'
  /** WSL older than 2.4.4. */
  | 'wslTooOld'
  /**
   * Windows has not restarted since Devspaces started the installation of WSL (WslSetupCommandsDeps.restartPending):
   * WSL 2 runs only after the restart.
   */
  | 'restartNeeded'
  /** WSL 2 cannot start its virtual machine (virtualMachineUnavailable). */
  | 'vmUnavailable'
  /** The pin of the image of the VM has no `.wsl` file for the architecture of Windows. */
  | 'noImage'
  | 'downloadFailed'
  /** `wsl --install --from-file` failed. */
  | 'registerFailed'
  /** Docker did not answer at the first start of the distribution. */
  | 'dockerNotRunning'
  /** `wsl --unregister` failed. */
  | 'removeFailed'
  /** WSL lists the distribution, but the registry cannot be read, so it is not known whether Devspaces set it up. */
  | 'registryFailed';

/** A failure of the setup or the removal; the message is technical (for the log), the problem chooses the text. */
export class WslSetupError extends Error {
  constructor(
    readonly problem: WslSetupProblem,
    message: string,
  ) {
    super(message);
    this.name = 'WslSetupError';
  }
}

export function isWslSetupError(error: unknown): error is WslSetupError {
  return error instanceof WslSetupError;
}

/**
 * Whether the distribution `devspaces` is registered: `none`; `own`, set up by Devspaces (the registry names a folder
 * in the folder of Devspaces as the folder of its virtual disk); or `foreign`, a distribution with that name that the
 * user made, which Devspaces never sets up or removes.
 */
export type WslRegistration = 'none' | 'own' | 'foreign';

/** A step of the setup, for the progress. */
export type WslSetupStep =
  | { kind: 'download'; received: number; total: number | undefined }
  | { kind: 'register' }
  /** The first start of the distribution and of Docker in it (in a virtual machine, it can take minutes). */
  | { kind: 'start' };

export interface WslSetupDeps {
  runner: ProcessRunner;
  /** The path of `wsl.exe` (findExecutable), or undefined. */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /** The architecture of Windows (readWindowsArch, `x64` or `arm64`), for the `.wsl` file; read at each new setup. */
  arch: () => Promise<string>;
  /** The folder of Devspaces for the distribution (wslSetupFolder): the virtual disk in `disk`, the download in `download`. */
  folder: string;
  logger: Logger;
  /** For tests. Default: `downloadVmImage`. */
  download?: (options: DownloadVmImageOptions) => Promise<unknown>;
  /** For tests. Default: VM_IMAGE_PIN. */
  pin?: VmImagePin;
  /** For tests. Default: a minute without a byte stops the download (downloadVmImage). */
  stalledAfterMs?: number;
}

export class WslSetup {
  constructor(private readonly deps: WslSetupDeps) {}

  private get downloadFolder(): string {
    return path.join(this.deps.folder, 'download');
  }

  private get regPath(): string {
    return regExePath(this.deps.env);
  }

  /**
   * The version of WSL, when it can register a file (WSL_FROM_FILE_VERSION). Throws WslSetupError `wslMissing` without
   * WSL, `wslTooOld` for an older WSL (an older `wsl.exe` knows no `--version`; `--status` then tells whether WSL is
   * installed).
   */
  async checkWsl(signal?: AbortSignal): Promise<string> {
    const versionResult = await this.runShort(WSL_VERSION_ARGS, signal);
    const version = versionResult.exitCode === 0 ? parseWslVersion(versionResult.stdout) : undefined;
    if (version !== undefined) {
      if (!supportsFromFile(version)) {
        throw new WslSetupError('wslTooOld', `WSL ${version.join('.')} cannot register a file; it needs ${WSL_FROM_FILE_VERSION.join('.')} or later.`);
      }
      return version.join('.');
    }
    const status = await this.runShort(WSL_STATUS_ARGS, signal);
    const detail = `wsl.exe --version ended with exit code ${versionResult.exitCode}: ${outputOf(versionResult)}`;
    if (status.exitCode === 0) throw new WslSetupError('wslTooOld', `${detail}. WSL is installed, but too old to show its version.`);
    throw new WslSetupError('wslMissing', `${detail}. wsl.exe --status ended with exit code ${status.exitCode}: ${outputOf(status)}`);
  }

  /**
   * Before the download of a new distribution: throws WslSetupError `vmUnavailable` when `wsl.exe --status` says that
   * WSL 2 cannot start, because the service of the Virtual Machine Platform of Windows is missing (WslClient.cpp of WSL;
   * for example before the restart after the installation of WSL). This check does not find every such case (for
   * example virtualization that is off in the firmware): the registration says so then. A status that cannot be read
   * does not stop the setup (logged). Throws an AbortError when the signal aborts.
   */
  async checkVirtualMachine(signal?: AbortSignal): Promise<void> {
    let status: RunResult;
    try {
      status = await this.runShort(WSL_STATUS_ARGS, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.deps.logger.info(`The status of WSL could not be read, so the registration shows whether WSL 2 can start: ${errorMessage(error)}`);
      return;
    }
    const output = `${status.stdout}\n${status.stderr}`;
    if (virtualMachineUnavailable(output)) {
      throw new WslSetupError('vmUnavailable', `wsl.exe --status says that WSL 2 cannot start: ${wslText(output).trim()}`);
    }
  }

  /**
   * Whether the distribution `devspaces` is registered, and whether Devspaces set it up (WslRegistration): from the
   * list of WSL and the folder of its virtual disk in the registry, `own` only when that folder is in the folder of
   * Devspaces. When `wsl.exe --list` fails otherwise than without any distribution, the registry alone decides, and
   * without the registry it is `none` (a WSL with no distribution may have no key in the registry yet); with `sure`
   * (a removal, which must not forget a distribution that still exists), it is `none` only when WSL is not installed
   * (wslInstalled), and else throws WslSetupError `registryFailed`. It throws that too when WSL lists the distribution
   * but the registry cannot be read: Devspaces never guesses that it set up a distribution.
   */
  async registration(signal?: AbortSignal, sure = false): Promise<WslRegistration> {
    const listed = await this.listed(signal);
    if (listed === false) return 'none';
    const folders = await this.distributionFolders(signal);
    if (folders === undefined) {
      if (listed === undefined && (!sure || !(await this.wslInstalled(signal)))) return 'none';
      throw new WslSetupError(
        'registryFailed',
        listed
          ? `WSL lists the distribution ${WSL_DISTRIBUTION}, but the registry (${LXSS_KEY}) cannot be read, so Devspaces cannot tell whether it set it up.`
          : `Neither the list of WSL nor the registry (${LXSS_KEY}) can be read, so Devspaces cannot tell whether the distribution ${WSL_DISTRIBUTION} exists.`,
      );
    }
    if (!folders.has(WSL_DISTRIBUTION)) return listed ? 'foreign' : 'none';
    const diskFolder = folders.get(WSL_DISTRIBUTION);
    return diskFolder !== undefined && (await isWithinResolved(diskFolder, this.deps.folder)) ? 'own' : 'foreign';
  }

  /**
   * Runs `task` while this window holds the lock of the setup for all windows of the Windows user (the lock folder
   * `<folder>.lock`, withLockFolder), so that two windows never set up or remove the distribution at the same time.
   * Undefined, without `task`, while another window holds it.
   */
  async locked<T>(task: () => Promise<T>): Promise<{ value: T } | undefined> {
    let started = false;
    try {
      const value = await withLockFolder(
        wslSetupLockFolder(this.deps.folder),
        () => {
          started = true;
          return task();
        },
        LOCK_TIMINGS,
      );
      return { value };
    } catch (error) {
      if (!started && error instanceof LockTimeoutError) return undefined;
      throw error;
    }
  }

  /**
   * The `.wsl` file of the image of the VM of Devspaces for the architecture of Windows, from the pin in the code of
   * Devspaces (no request). Throws WslSetupError `noImage` when the pin has none for it.
   */
  async image(): Promise<WslImage> {
    const arch = await this.deps.arch();
    const pin = this.deps.pin ?? VM_IMAGE_PIN;
    const file = vmImageFile('wsl', arch, pin);
    if (file === undefined) throw new WslSetupError('noImage', `The image ${pin.version ?? '(none)'} of the VM of Devspaces has no .wsl file for ${arch}.`);
    return { ...file, arch, repository: pin.repository };
  }

  /**
   * Sets up the distribution: downloads `image` into the folder `download`, registers it with its virtual disk in a
   * folder `disk` (diskFolderFor), and removes the download; then the first start of the distribution, in which systemd
   * starts Docker, and Docker must answer. Returns the version of the engine, and what WslSetup.separate found after
   * the registration. Throws WslSetupError, or an AbortError when the signal aborts. The registration itself is not
   * cancelled: the service of WSL would go on with it after the end of wsl.exe, so a cancel takes effect after it.
   */
  async setUp(image: WslImage, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<{ version: string; separation: WslSeparation }> {
    await this.register(image, onStep, signal);
    // WSL makes a new distribution the default when it has none.
    const separation = await this.separate();
    // The first start of a new distribution can take minutes (in a virtual machine).
    onStep({ kind: 'start' });
    const wait = await this.waitForDocker(signal);
    if (wait.exitCode !== 0) {
      throw new WslSetupError('dockerNotRunning', `Docker does not answer at the first start of the WSL distribution ${WSL_DISTRIBUTION} (${endOf(wait, START_MS)}): ${outputOf(wait)}`);
    }
    const version = wslText(wait.stdout).trim();
    this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} runs Docker Engine ${version}.`);
    return { version, separation };
  }

  /**
   * The script that waits for Docker (DOCKER_WAIT_SCRIPT) after the restart of the distribution. When WSL ran out of time
   * to start the distribution (startTimedOut), it starts it again, at most WSL_START_ATTEMPTS times.
   */
  private async waitForDocker(signal?: AbortSignal): Promise<RunResult> {
    for (let attempt = 1; ; attempt++) {
      const wait = await this.runWsl(wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-s']), { input: DOCKER_WAIT_SCRIPT, timeoutMs: START_MS, signal });
      if (wait.exitCode === 0 || wait.timedOut || attempt >= WSL_START_ATTEMPTS || !startTimedOut(wait)) return wait;
      this.deps.logger.info(`WSL ran out of time to start the distribution ${WSL_DISTRIBUTION} (attempt ${attempt} of ${WSL_START_ATTEMPTS}), so Devspaces starts it again: ${outputOf(wait)}`);
    }
  }

  /**
   * "Stop the VM…" (R-VM-010): `wsl --terminate devspaces`, which stops the distribution with its devspaces and its
   * Docker; nothing is deleted. Its next use starts it again. Throws an Error with a technical message when WSL refuses
   * or does not answer within TERMINATE_MS.
   */
  async stop(signal?: AbortSignal): Promise<void> {
    const result = await this.runWsl(WSL_TERMINATE_ARGS, { timeoutMs: TERMINATE_MS, signal });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`wsl.exe ${WSL_TERMINATE_ARGS.join(' ')} failed (${endOf(result, TERMINATE_MS)}): ${outputOf(result)}`);
    }
    this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was stopped.`);
  }

  /**
   * `wsl --unregister devspaces`, which deletes the distribution with everything in it, then the folder of Devspaces,
   * unless another WSL distribution has its virtual disk there (removeLeftovers). Only for a distribution that Devspaces
   * set up (the caller checks `registration`). True when the folder is gone. Throws WslSetupError `removeFailed`.
   */
  async remove(signal?: AbortSignal): Promise<boolean> {
    const result = await this.runWsl(WSL_UNREGISTER_ARGS, { timeoutMs: UNREGISTER_MS, signal });
    if (result.exitCode !== 0) {
      throw new WslSetupError('removeFailed', `wsl.exe ${WSL_UNREGISTER_ARGS.join(' ')} failed (${endOf(result, UNREGISTER_MS)}): ${outputOf(result)}`);
    }
    this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was removed.`);
    return this.removeLeftovers();
  }

  /**
   * The WSL distributions that have their virtual disk in the folder of Devspaces (the registry, else `wsl.exe --list`),
   * or undefined when neither tells. For removeLeftovers and the uninstall hook (src/uninstall/main.ts), which keep the
   * folder unless the list is empty. Never throws.
   */
  folderUsers(): Promise<string[] | undefined> {
    return this.diskUsers(this.deps.folder).catch(() => undefined);
  }

  /**
   * Removes the folder of Devspaces when no WSL distribution has its virtual disk there (the registry): after the
   * removal, or the files of a setup that did not end. True when the folder is gone. Never throws (logged).
   */
  async removeLeftovers(): Promise<boolean> {
    const { folder, logger } = this.deps;
    const exists = await fs.promises.access(folder).then(
      () => true,
      (error: unknown) => errorCode(error) !== 'ENOENT',
    );
    if (!exists) return true;
    const users = await this.folderUsers();
    if (users === undefined || users.length > 0) {
      logger.warn(`The folder ${folder} stays: ${users === undefined ? 'neither the registry nor WSL tells whether a WSL distribution uses it' : `the WSL distribution ${users.join(', ')} has its virtual disk there`}.`);
      return false;
    }
    return fs.promises.rm(folder, { recursive: true, force: true }).then(
      () => {
        logger.info(`The folder ${folder} was removed.`);
        return true;
      },
      (error: unknown) => {
        logger.warn(`The folder ${folder} could not be removed: ${errorMessage(error)}`);
        return false;
      },
    );
  }

  private async register(image: WslImage, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<void> {
    const file = path.join(this.downloadFolder, image.name);
    const diskFolder = await this.diskFolderFor(signal);
    await fs.promises.mkdir(this.downloadFolder, { recursive: true });
    await fs.promises.mkdir(diskFolder, { recursive: true });
    await this.removeOtherDownloads(image.name);
    let keep = false;
    try {
      onStep({ kind: 'download', received: 0, total: image.size });
      await this.downloadImage(image, file, onStep, signal);
      onStep({ kind: 'register' });
      const args = wslInstallArgs(file, diskFolder);
      this.deps.logger.info(`wsl.exe ${args.join(' ')}`);
      // Without the signal (setUp). After the time limit, WSL may still end the registration: the next setup then finds
      // the distribution of Devspaces and uses it. Windows removes no file that WSL still has open (the download, the
      // virtual disk): such a removal fails, below and in diskFolderFor, and changes nothing.
      const result = await this.runWsl(args, { timeoutMs: REGISTER_MS });
      if (result.exitCode !== 0) {
        const detail = `wsl.exe --install --from-file failed (${endOf(result, REGISTER_MS)}): ${outputOf(result)}`;
        if (!result.timedOut && virtualMachineUnavailable(`${result.stdout}\n${result.stderr}`)) {
          // The checked file serves the next setup, after the restart or the change of the settings of virtualization.
          keep = true;
          throw new WslSetupError('vmUnavailable', `${detail} The download stays for the next setup: ${file}`);
        }
        throw new WslSetupError('registerFailed', detail);
      }
      this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was registered with its virtual disk in ${diskFolder}.`);
      if (signal?.aborted) {
        // The cancel takes effect after the registration, which WSL may have made its default.
        await this.separate();
        throw abortError();
      }
    } finally {
      if (!keep) {
        await fs.promises.rm(file, { force: true }).catch((error: unknown) => {
          this.deps.logger.warn(`The download ${file} could not be removed: ${errorMessage(error)}`);
        });
      }
    }
  }

  /**
   * Removes the files in the folder `download` other than `keep`: a download that stayed for the next setup
   * (`vmUnavailable`) of another version of the image, or of an older version of Devspaces. A failure is logged.
   */
  private async removeOtherDownloads(keep: string): Promise<void> {
    for (const name of (await filesOf(this.downloadFolder)) ?? []) {
      if (name === keep) continue;
      const other = path.join(this.downloadFolder, name);
      await fs.promises.rm(other, { recursive: true, force: true }).then(
        () => this.deps.logger.info(`The download ${other} of an earlier setup was removed.`),
        (error: unknown) => this.deps.logger.warn(`The download ${other} of an earlier setup could not be removed: ${errorMessage(error)}`),
      );
    }
  }

  /**
   * The download from ghcr.io (downloadVmImage), checked against the SHA-256 of the pin; it stops when no bytes arrive
   * for a minute. The file of an earlier setup that WSL could not register (`vmUnavailable`) is used again when it has
   * the SHA-256 of the pin.
   */
  private async downloadImage(image: WslImage, file: string, onStep: (step: WslSetupStep) => void, signal?: AbortSignal): Promise<void> {
    const sha256 = image.digest.slice('sha256:'.length);
    const kept = await fileSize(file, sha256);
    if (kept !== undefined) {
      this.deps.logger.info(`The .wsl file of the VM of Devspaces of an earlier setup is used again: ${file} has the SHA-256 ${sha256} of the pin.`);
      onStep({ kind: 'download', received: kept, total: kept });
      return;
    }
    this.deps.logger.info(`The .wsl file of the image ${image.version} of the VM of Devspaces is downloaded from ${image.repository} (${image.name}, ${image.size} bytes, SHA-256 ${sha256}).`);
    try {
      await (this.deps.download ?? downloadVmImage)({
        kind: 'wsl',
        arch: image.arch,
        target: file,
        signal,
        pin: this.deps.pin,
        stalledAfterMs: this.deps.stalledAfterMs,
        onProgress: (received, total) => onStep({ kind: 'download', received, total: total ?? image.size }),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new WslSetupError('downloadFailed', `The .wsl file of the VM of Devspaces could not be downloaded from ${image.repository}: ${errorMessage(error)}`);
    }
  }

  /**
   * The folder for the virtual disk of a new registration (`--location`), so that WSL creates it in an empty folder:
   * `disk`, emptied when it has the files of a setup that did not end and no WSL distribution uses them. When that is
   * not known, nothing is removed on a guess: the first empty folder `disk-2`, `disk-3` and so on.
   */
  private async diskFolderFor(signal?: AbortSignal): Promise<string> {
    const first = path.join(this.deps.folder, 'disk');
    const names = await filesOf(first);
    if (names?.length === 0) return first;
    const users = names === undefined ? undefined : await this.diskUsers(first, signal);
    let removalError: unknown;
    if (names !== undefined && users?.length === 0) {
      this.deps.logger.info(`The folder ${first} has the files of a setup that did not end (${names.join(', ')}); they are removed.`);
      try {
        await fs.promises.rm(first, { recursive: true, force: true });
        return first;
      } catch (error) {
        // For example a file that WSL still has open.
        removalError = error;
      }
    }
    const content = names === undefined ? 'cannot be read' : `has files (${names.join(', ')})`;
    const why =
      removalError !== undefined
        ? `they could not be removed (${errorMessage(removalError)})`
        : names === undefined
          ? 'what is in it is not known'
          : users === undefined
            ? 'neither the registry nor WSL tells whether a WSL distribution uses it'
            : `the WSL distribution ${users.join(', ')} has its virtual disk there`;
    for (let number = 2; number <= MAX_DISK_FOLDERS; number++) {
      const next = path.join(this.deps.folder, `disk-${number}`);
      if ((await filesOf(next))?.length !== 0) continue;
      this.deps.logger.info(`The folder ${first} ${content}, and ${why}; the new distribution gets the folder ${next}.`);
      return next;
    }
    throw new WslSetupError('registerFailed', `The folders ${first} to disk-${MAX_DISK_FOLDERS} all have files, and ${why}.`);
  }

  /**
   * The WSL distributions (names in lower case) with their virtual disk in `parent`, from the registry; undefined when
   * it names none there but does not tell the folder of a distribution. Without the registry, only the distribution
   * `devspaces` can have it there (Devspaces registers no other one): then `wsl.exe --list` must answer. Undefined when
   * neither tells. Throws an AbortError when the signal aborts.
   */
  private async diskUsers(parent: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const folders = await this.distributionFolders(signal);
    if (folders !== undefined) {
      const entries = [...folders.entries()];
      const users: string[] = [];
      for (const [name, diskFolder] of entries) {
        if (diskFolder !== undefined && (await isWithinResolved(diskFolder, parent))) users.push(name);
      }
      return users.length > 0 || entries.every(([, diskFolder]) => diskFolder !== undefined) ? users : undefined;
    }
    try {
      const listed = await this.listed(signal);
      return listed === undefined ? undefined : listed ? [WSL_DISTRIBUTION] : [];
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.deps.logger.info(`WSL does not list its distributions: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Whether WSL is installed: `wsl.exe --version` or, from an older WSL, `wsl.exe --status` ends with exit code 0 (as
   * in checkWsl). Throws WslSetupError (runShort).
   */
  private async wslInstalled(signal?: AbortSignal): Promise<boolean> {
    if ((await this.runShort(WSL_VERSION_ARGS, signal)).exitCode === 0) return true;
    return (await this.runShort(WSL_STATUS_ARGS, signal)).exitCode === 0;
  }

  /**
   * Keeps the WSL distribution of Devspaces from being the default distribution of WSL, which `wsl` without `-d` opens
   * (as root there) and which Docker Desktop integrates by default. WSL makes a new distribution the default when it
   * has none, and the first one that is left after the removal of the default (LxssUserSession.cpp of WSL). Then the
   * first other installed distribution of the registry that takes it becomes the default (`wsl.exe --set-default`, as
   * WSL would choose without the one of Devspaces; never the machine of a tool, isToolDistribution), or, when WSL
   * refuses all, WSL has no default (the value DefaultDistribution goes; `wsl --list` still lists the distributions,
   * and WSL makes the next new distribution the default). After a call that WSL does not answer, nothing more is tried
   * until the next check. Only for a distribution that Devspaces set up (the folder of its virtual disk is in the
   * folder of Devspaces); without the folder of Devspaces, nothing runs. Not cancelled: a cancel would leave the
   * distribution the default. A failure is logged; never throws.
   */
  async separate(): Promise<WslSeparation> {
    if (!(await fs.promises.access(this.deps.folder).then(() => true, () => false))) return { state: 'none', dockerDesktop: undefined };
    const registry = await this.readRegistry();
    if (registry === undefined) return { state: 'unknown', dockerDesktop: undefined };
    const dockerDesktop = registry.distributions.some((distribution) => isDockerDesktopDistribution(distribution.name));
    const result = (state: WslSeparation['state']): WslSeparation => ({ state, dockerDesktop });
    const ours = registry.distributions.find((distribution) => distribution.name.toLowerCase() === WSL_DISTRIBUTION);
    if (ours?.basePath === undefined || !(await isWithinResolved(ours.basePath, this.deps.folder))) return result('none');
    if (registry.defaultId !== ours.id) return result('separate');
    const others = registry.distributions.filter(
      (distribution) => distribution !== ours && distribution.installed !== false && !isToolDistribution(distribution.name),
    );
    const failures: string[] = [];
    const stays = (): WslSeparation => {
      this.deps.logger.warn(`The WSL distribution ${WSL_DISTRIBUTION} of Devspaces stays the default distribution of WSL: ${failures.join('; ')}`);
      return result('default');
    };
    /** True when `run` ended well; false after a failure; undefined when WSL did not answer or start (WslSetupError). */
    const attempt = async (what: string, run: () => Promise<RunResult>, done: string): Promise<boolean | undefined> => {
      try {
        const ended = await run();
        if (ended.exitCode === 0 && !ended.timedOut) {
          this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} of Devspaces was the default distribution of WSL; ${done}.`);
          return true;
        }
        failures.push(`${what} ended with ${endOf(ended, SHORT_CALL_MS)}: ${outputOf(ended)}`);
        return false;
      } catch (error) {
        failures.push(`${what}: ${errorMessage(error)}`);
        return error instanceof WslSetupError ? undefined : false;
      }
    };
    for (const other of others) {
      const args = wslSetDefaultArgs(other.name);
      const done = await attempt(`wsl.exe ${args.join(' ')}`, () => this.runShort(args), `now ${other.name} is`);
      if (done) return result('separate');
      // WSL may only be slow (just after the logon, or busy with a setup in another window): the next window start
      // tries again, and the user keeps a default.
      if (done === undefined) return stays();
    }
    // Only while the default is still the one of Devspaces: the user, or a removal in another window, may have changed
    // it meanwhile, and that default stays.
    const now = await this.readRegistry();
    if (now === undefined) return stays();
    if (now.defaultId !== ours.id) return result('separate');
    const removed = await attempt(
      'reg.exe delete',
      () => this.deps.runner.run(this.regPath, regDeleteDefaultArgs(), { timeoutMs: SHORT_CALL_MS }),
      'now WSL has no default, so "wsl" without "-d" does not open it',
    );
    return removed ? result('separate') : stays();
  }

  /**
   * Whether `wsl.exe --list` names the distribution `devspaces` (WSL compares the names without case): false also when
   * WSL has no distribution (NO_DISTRIBUTIONS); undefined when the list ends with another exit code that is not 0.
   * Throws WslSetupError (runShort).
   */
  private async listed(signal?: AbortSignal): Promise<boolean | undefined> {
    return listsDistribution(await this.runShort(WSL_LIST_ARGS, signal), WSL_DISTRIBUTION);
  }

  /**
   * The folders of the virtual disks of the WSL distributions of the Windows user by name in lower case
   * (readRegistry), or undefined when the registry cannot be read (logged). Throws an AbortError when the signal aborts.
   */
  private async distributionFolders(signal?: AbortSignal): Promise<Map<string, string | undefined> | undefined> {
    const registry = await this.readRegistry(signal);
    return registry && distributionFoldersOf(registry);
  }

  /**
   * The WSL distributions of the Windows user in the registry (`reg.exe export` into a new temporary folder, removed
   * after the read), or undefined when it cannot be read (logged). Throws an AbortError when the signal aborts.
   */
  private async readRegistry(signal?: AbortSignal): Promise<LxssRegistry | undefined> {
    let temporary: string | undefined;
    try {
      temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-registry-'));
      const file = path.join(temporary, REGISTRY_EXPORT_NAME);
      const result = await this.deps.runner.run(this.regPath, regExportArgs(file), { timeoutMs: SHORT_CALL_MS, signal });
      if (result.exitCode !== 0) throw new Error(`reg.exe export ended with ${endOf(result, SHORT_CALL_MS)}: ${outputOf(result)}`);
      return parseLxss(await fs.promises.readFile(file));
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.deps.logger.warn(`The WSL distributions could not be read from the registry (${LXSS_KEY}): ${errorMessage(error)}`);
      return undefined;
    } finally {
      if (temporary !== undefined) await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A short call of `wsl.exe` (runWsl) that must end within 15 seconds: else WslSetupError `wslNotAnswering`. */
  private async runShort(args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
    const result = await this.runWsl(args, { timeoutMs: SHORT_CALL_MS, signal });
    if (result.timedOut) throw new WslSetupError('wslNotAnswering', `wsl.exe ${args.join(' ')} did not answer within ${duration(SHORT_CALL_MS)}.`);
    return result;
  }

  /**
   * `wsl.exe` with `args` (WSL_UTF8=1). Throws WslSetupError `wslMissing` when it is not found, `wslNotAnswering` when
   * it cannot start for another reason (a removal must not take that for a missing WSL), and an AbortError when the
   * signal aborts.
   */
  private async runWsl(args: readonly string[], options: RunOptions): Promise<RunResult> {
    const wsl = this.deps.wslPath();
    if (wsl === undefined) throw new WslSetupError('wslMissing', 'wsl.exe was not found.');
    try {
      return await this.deps.runner.run(wsl, args, { ...options, env: wslEnv(this.deps.env) });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      throw new WslSetupError(errorCode(error) === 'ENOENT' ? 'wslMissing' : 'wslNotAnswering', `wsl.exe could not be started: ${errorMessage(error)}`);
    }
  }
}

/**
 * The size of the regular file `file` (not a link) when it has the SHA-256 `sha256` (hex in lower case); undefined when
 * it is missing, cannot be read, or has another content.
 */
async function fileSize(file: string, sha256: string): Promise<number | undefined> {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile()) return undefined;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex') === sha256 ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

/** The names in `folder`: none when it does not exist; undefined when it cannot be read (it counts as one with files). */
async function filesOf(folder: string): Promise<string[] | undefined> {
  try {
    return await fs.promises.readdir(folder);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? [] : undefined;
  }
}

/** The output of a call for the log (wslText): standard error, else standard output. */
export function outputOf(result: RunResult): string {
  const text = wslText(result.stderr || result.stdout).trim();
  return text === '' ? '(no output)' : text;
}

/** How a call ended, for the log. */
export function endOf(result: RunResult, timeoutMs: number): string {
  return result.timedOut ? `no end within ${duration(timeoutMs)}` : `exit code ${result.exitCode}`;
}

/** A time limit in words: `30 minutes`, `90 seconds`. */
export function duration(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}
