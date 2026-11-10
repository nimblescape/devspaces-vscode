// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker setup: the context keys of the Docker setup in the sidebar, and the terminal of the installation of WSL 2 on
// Windows and of QEMU on Linux. Devspaces never installs Docker Desktop or Docker Engine on this computer: it sets up
// Docker Engine in its own VM (docs/requirements.md R-GEN-002, R-VM-001). Pure functions; the VS Code side is in
// src/vscode/dockerSetup.ts.

/** Context keys of the welcome view (package.json) and of the Docker setup. */
export const DockerContextKeys = {
  /** No Docker CLI was found. */
  missing: 'devspaces.dockerMissing',
  /** `dockerSetupRequired`: the sidebar shows the Docker setup instead of the repositories (welcome view). */
  setupRequired: 'devspaces.dockerSetupRequired',
  /** A Docker CLI was found (the opposite of `missing`). */
  installed: 'devspaces.dockerInstalled',
  /** The last `docker info` succeeded. */
  ready: 'devspaces.dockerReady',
  /** Windows: `wsl --status` succeeded (the sidebar shows "✓ WSL 2 is installed." instead of its button). */
  wslReady: 'devspaces.wslReady',
} as const;

export type DockerContextKey = (typeof DockerContextKeys)[keyof typeof DockerContextKeys];

/** While the CLI is missing, it is looked up this often. */
export const MISSING_CLI_CHECK_MS = 10_000;
/** After an installation was started, the CLI is looked up this often… */
export const INSTALL_WATCH_INTERVAL_MS = 5_000;
/** …for at most this long. */
export const INSTALL_WATCH_TIMEOUT_MS = 30 * 60_000;

/**
 * Docker Desktop on Windows needs WSL 2, and so does the WSL distribution of Devspaces. Without a distribution
 * (`--no-distribution`, basic-commands.md of MicrosoftDocs/WSL): both bring their own, and the Ubuntu that
 * `wsl --install` adds by default would ask for a Linux user after the restart.
 */
export const WSL_INSTALL_COMMAND = 'wsl --install --no-distribution';

// User-visible texts that messages.ts lacks; to be moved there.
export const DockerSetupTexts = {
  /** While the terminal installs WSL 2 (no question before it: Windows asks for administrator permission itself). */
  wslInstalling: (terminal: string, command: string) =>
    `Devspaces installs WSL 2, which its Docker needs, in the terminal "${terminal}". Windows asks for administrator permission; without it, ask an administrator of this computer to run "${command}". ` +
    'Then restart Windows and open VS Code again: Devspaces goes on with the setup of its Docker by itself.',
  /** WSL 2 is installed, and Windows has not restarted since Devspaces started its installation. */
  wslRestartToGoOn: 'Restart Windows to finish the installation of WSL 2. Then open VS Code again: Devspaces goes on with the setup of its Docker by itself.',
} as const;

/** Parses /etc/os-release (`KEY=value`, values optionally quoted). */
export function parseOsRelease(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\$`])/g, '$1');
    }
    fields[match[1]] = value;
  }
  return fields;
}

/**
 * True for an HTTPS URL of `host` without another port: the downloads of Docker (dockerDownload.ts) come only from such
 * URLs, also the target of a redirect.
 */
export function isHttpsUrlOf(url: string, host: string): boolean {
  return isHttpsUrl(url) && new URL(url).hostname === host;
}

/** True for an HTTPS URL on the default port, of any host (a download that a SHA-256 checks). */
export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.port === '';
  } catch {
    return false;
  }
}

/** The terminal in which the commands run (vscode.TerminalOptions without the name). */
export interface InstallTerminalOptions {
  shellPath: string;
  cwd: string;
  env: Record<string, string>;
  strictEnv: true;
}

/** Search path of the install terminal on Linux (QEMU). */
const LINUX_INSTALL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Variables of the extension host that the install terminal keeps on Linux (a proxy of the computer). */
const KEPT_VARIABLES = [
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  // Certificates of a company network.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
];
/** Variables of Windows that the install terminal keeps; everything else (also PATH) is fixed. */
const KEPT_WINDOWS_VARIABLES = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'USERNAME',
  'USERDOMAIN',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'COMPUTERNAME',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

/**
 * The install terminal (WSL 2 on Windows, QEMU on Linux; macOS installs nothing): a fixed shell of the system, the home
 * folder, and a fixed environment (`strictEnv`), so that neither the terminal settings of a workspace (profiles,
 * `terminal.integrated.env.*`) nor files of the opened folder change what the listed commands run. The search path is
 * fixed on every platform (on Windows the folders of the system and the WindowsApps folder of the user); a few
 * variables of the computer are kept (language, proxy, certificates, on Windows the folders of the user).
 */
export function installTerminalOptions(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  userName: string | undefined,
): InstallTerminalOptions {
  if (platform === 'win32') {
    // Names of variables are not case-sensitive on Windows.
    const byName = new Map(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
    const systemRoot = byName.get('systemroot') ?? 'C:\\Windows';
    const kept: Record<string, string> = {};
    for (const name of KEPT_WINDOWS_VARIABLES) {
      const value = byName.get(name.toLowerCase());
      if (value !== undefined) kept[name] = value;
    }
    kept.SystemRoot = systemRoot;
    // wsl.exe is in System32; the WindowsApps folder of the user holds the app execution aliases of Store apps.
    const folders = [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`];
    const localAppData = byName.get('localappdata');
    if (localAppData) folders.push(`${localAppData}\\Microsoft\\WindowsApps`);
    kept.PATH = folders.join(';');
    return { shellPath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, cwd: home, env: kept, strictEnv: true };
  }
  const fixed: Record<string, string> = { PATH: LINUX_INSTALL_PATH, HOME: home };
  if (userName) {
    fixed.USER = userName;
    fixed.LOGNAME = userName;
  }
  for (const name of KEPT_VARIABLES) {
    const value = env[name];
    if (value !== undefined) fixed[name] = value;
  }
  return { shellPath: '/bin/sh', cwd: home, env: fixed, strictEnv: true };
}

/** The lines that the terminal gets: one line with `&&` (stops at the first error), on Windows one line per command. */
export function terminalLines(commands: readonly string[], platform: NodeJS.Platform): string[] {
  // Windows PowerShell before version 7 has no `&&`, and the default shell of the terminal is not known.
  if (platform === 'win32') return [...commands];
  return commands.length === 0 ? [] : [commands.join(' && ')];
}

/** What the extension knows about Docker on this computer. */
export interface DockerSetupState {
  cliFound: boolean;
  /** The last `docker info` succeeded. Unknown counts as false: Docker is not asked in the background. */
  engineRunning: boolean;
  /** Windows: `wsl --status` succeeded. */
  wslReady: boolean;
}

export type DockerSetupEvent =
  | { kind: 'cli'; found: boolean }
  | { kind: 'engine'; running: boolean }
  | { kind: 'wsl'; ready: boolean };

export const INITIAL_DOCKER_SETUP_STATE: DockerSetupState = { cliFound: false, engineRunning: false, wslReady: false };

/** The next state after a check. Without a CLI, Docker cannot run; an engine that answers implies a CLI. */
export function nextDockerSetupState(state: DockerSetupState, event: DockerSetupEvent): DockerSetupState {
  switch (event.kind) {
    case 'cli':
      return { ...state, cliFound: event.found, engineRunning: event.found && state.engineRunning };
    case 'engine':
      return { ...state, engineRunning: event.running, cliFound: state.cliFound || event.running };
    case 'wsl':
      return { ...state, wslReady: event.ready };
  }
}

/**
 * True while the sidebar shows the Docker setup instead of the repositories: Devspaces has no Docker host (its own VM,
 * or another host of its list). Devspaces never uses the Docker of this computer (docs/requirements.md R-ENG-001), so a
 * Docker CLI or a Docker Desktop of this computer does not count.
 */
export function dockerSetupRequired(dockerHostConfigured: boolean): boolean {
  return !dockerHostConfigured;
}

/** Values of the context keys of a state (`dockerHostConfigured`: see dockerSetupRequired). */
export function dockerContextValues(state: DockerSetupState, dockerHostConfigured: boolean): Record<DockerContextKey, boolean> {
  return {
    [DockerContextKeys.missing]: !state.cliFound,
    [DockerContextKeys.installed]: state.cliFound,
    [DockerContextKeys.ready]: state.cliFound && state.engineRunning,
    [DockerContextKeys.wslReady]: state.wslReady,
    [DockerContextKeys.setupRequired]: dockerSetupRequired(dockerHostConfigured),
  };
}

/** The context keys that change from `before` to `after` (all keys when `before` is undefined: nothing was set yet). */
export function changedContextValues(
  before: Readonly<Record<DockerContextKey, boolean>> | undefined,
  after: Readonly<Record<DockerContextKey, boolean>>,
): Array<[DockerContextKey, boolean]> {
  return (Object.keys(after) as DockerContextKey[]).filter((key) => before?.[key] !== after[key]).map((key) => [key, after[key]]);
}

/** True while the CLI is looked up every 10 s: only while it is missing. */
export function needsMissingCliCheck(state: DockerSetupState): boolean {
  return !state.cliFound;
}

/** True while the CLI is looked up every 5 s after an installation started: until found, for at most 30 minutes. */
export function keepWatchingInstall(state: DockerSetupState, startedAt: number, now: number): boolean {
  return !state.cliFound && now - startedAt < INSTALL_WATCH_TIMEOUT_MS;
}
