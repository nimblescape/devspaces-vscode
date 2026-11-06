// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scheduled task of the user that starts the Lima VM of Devspaces and its Monitor at the times of
// devspaces.cacheUpdateSchedule (R-VM-005), on macOS (a launch agent) and on Linux (a systemd user timer). The task runs
// the program of the task (src/vmTask/main.ts, a copy of dist/vmTask.js in the folder of the task) with the Electron of
// VS Code as Node.js (ELECTRON_RUN_AS_NODE, as the `code` command of VS Code does). The trigger of the task only wakes
// the program: at the minute of the schedule every hour (every 15 minutes for an interval), and at the login of the user
// (RunAtLoad of launchd; Persistent of systemd, which starts a missed time when the timer starts again). The program
// decides: it starts the VM only when a time of the schedule passed since its last start (vmTaskDue). The settings of
// the task are a file next to the program (VmTaskConfig), which Devspaces writes again when the setting changes; the
// definition of the task changes only with the minute of its trigger or with the path of the Electron of VS Code. No
// `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner } from '../ports';
import { cacheRunDue, parseCacheSchedule, type CacheSchedule } from '../remoteMonitor/cacheSettings';
import type { ImageSettings } from '../remoteMonitor/protocol';

/** The name of the units of systemd (`devspaces-vm.service` and `devspaces-vm.timer`). */
export const VM_TASK_UNIT = 'devspaces-vm';
/** The label of the launch agent of macOS, also the name of its file in ~/Library/LaunchAgents. */
export const VM_TASK_LABEL = 'com.nimblescape.devspaces.vm';
/** The program waits this long before it starts the VM, so that the network is back after a wake or a login. */
export const VM_TASK_WAIT_MS = 5 * 60_000;
/** The minutes of the hour at which the trigger wakes the program for an interval schedule. */
export const VM_TASK_INTERVAL_MINUTES: readonly number[] = [0, 15, 30, 45];
/**
 * The argument after the program that the Electron of VS Code needs to run it as Node.js (the `code` command of VS Code
 * passes it after its own script in the same place).
 */
export const RUN_AS_NODE_ARG = '--ms-enable-electron-run-as-node';
/** The time limit of each call of `systemctl` and `launchctl`. */
const TASK_CALL_TIMEOUT_MS = 30_000;

/** The files of the task in the folder of the files of Devspaces outside of VS Code (`~/.nimblescape/devspaces/task`). */
export interface VmTaskPaths {
  /** The folder of the task. */
  folder: string;
  /** The program of the task: a copy of dist/vmTask.js. */
  program: string;
  /** The settings of the task (VmTaskConfig). */
  config: string;
  /** The time of the last start of the VM by the task (VmTaskStamp), written only by the program. */
  stamp: string;
  /** The log of the program. */
  log: string;
}

/** The files of the task under `root` (LimaPaths.root). */
export function vmTaskPaths(root: string): VmTaskPaths {
  const folder = path.join(root, 'task');
  return {
    folder,
    program: path.join(folder, 'vmTask.js'),
    config: path.join(folder, 'task.json'),
    stamp: path.join(folder, 'last-start.json'),
    log: path.join(folder, 'task.log'),
  };
}

/** The settings of the task, which the program reads at each start. */
export interface VmTaskConfig extends ImageSettings {
  /** `limactl` of the pinned Lima (presentLima). */
  limactl: string;
  /** LIMA_HOME of Devspaces (LimaPaths.home). */
  limaHome: string;
}

/** The settings of the task in `text`, or undefined when they are not complete. */
export function parseVmTaskConfig(text: string): VmTaskConfig | undefined {
  try {
    const value = JSON.parse(text) as Partial<Record<keyof VmTaskConfig, unknown>>;
    const { schedule, timeZone, limactl, limaHome } = value;
    if (typeof schedule !== 'string' || typeof timeZone !== 'string' || typeof limactl !== 'string' || typeof limaHome !== 'string') return undefined;
    return { schedule, timeZone, limactl, limaHome };
  } catch {
    return undefined;
  }
}

/** The time of the last start in the stamp of the task, or undefined when there is none. */
export function parseVmTaskStamp(text: string): number | undefined {
  try {
    const value = (JSON.parse(text) as { lastStartAt?: unknown }).lastStartAt;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The text of the stamp of the task with the last start at `at`. */
export function vmTaskStampText(at: number): string {
  return `${JSON.stringify({ lastStartAt: at })}\n`;
}

/**
 * Whether the program starts the VM now: a time of the schedule passed since the last start (cacheRunDue, as the
 * Monitor decides about its run). Without a last start, it is not due: the stamp is written when the task is created, so
 * that the task does not start the VM at once.
 */
export function vmTaskDue(config: ImageSettings, lastStartAt: number | undefined, now: number): boolean {
  const schedule = parseCacheSchedule(config.schedule);
  if (schedule === undefined || lastStartAt === undefined) return false;
  return cacheRunDue(schedule, lastStartAt, now, config.timeZone);
}

/**
 * The minutes of the hour at which the trigger wakes the program: the minute of a cron schedule (one value, because two
 * times of a schedule are at least 60 minutes apart, MIN_CACHE_INTERVAL_MINUTES), and every 15 minutes for an interval.
 */
export function vmTaskTriggerMinutes(schedule: CacheSchedule): number[] {
  if (schedule.kind === 'interval') return [...VM_TASK_INTERVAL_MINUTES];
  return [...schedule.cron.minutes].sort((a, b) => a - b);
}

/** The program of the task: the Electron of VS Code with the program file and the settings file. */
export interface VmTaskProgram {
  /** The Electron of VS Code (process.execPath of the extension host). */
  electron: string;
  paths: VmTaskPaths;
}

/**
 * The Electron of VS Code that runs the program as Node.js: on macOS the program of the app, `Contents/MacOS/Electron`
 * next to `Contents/Resources/app` (`appRoot`), which the `code` command of VS Code runs in the same way; elsewhere, and
 * when that file does not exist, the program of this process (`execPath`).
 */
export function vscodeElectron(platform: NodeJS.Platform, appRoot: string, execPath: string, exists: (file: string) => boolean = fs.existsSync): string {
  if (platform !== 'darwin') return execPath;
  const app = path.join(appRoot, '..', '..', 'MacOS', 'Electron');
  return exists(app) ? app : execPath;
}

/** The arguments of the Electron of VS Code: the program, the argument of the run as Node.js, and the settings file. */
export function vmTaskArgs(paths: VmTaskPaths): string[] {
  return [paths.program, RUN_AS_NODE_ARG, paths.config];
}

/** A word of a command line of systemd (ExecStart): in double quotes, with `\`, `"`, `%` and `$` escaped. */
function systemdWord(word: string): string {
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** The text of the service of systemd: one run of the program, with the Electron of VS Code as Node.js. */
export function systemdServiceText(program: VmTaskProgram): string {
  return [
    '[Unit]',
    'Description=nimblescape Devspaces: start the VM of Devspaces at the times of devspaces.cacheUpdateSchedule',
    '',
    '[Service]',
    'Type=oneshot',
    'Environment=ELECTRON_RUN_AS_NODE=1',
    `ExecStart=${[program.electron, ...vmTaskArgs(program.paths)].map(systemdWord).join(' ')}`,
    '',
  ].join('\n');
}

/**
 * The text of the timer of systemd: every hour at `minutes`, and a missed time at the next start of the timer (the login
 * of the user, Persistent). It never wakes the computer (no WakeSystem).
 */
export function systemdTimerText(minutes: readonly number[]): string {
  return [
    '[Unit]',
    'Description=nimblescape Devspaces: the times of devspaces.cacheUpdateSchedule',
    '',
    '[Timer]',
    `OnCalendar=*-*-* *:${minutes.map((minute) => String(minute).padStart(2, '0')).join(',')}:00`,
    'Persistent=true',
    'AccuracySec=1s',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

/** `text` for a string of a property list, with `&`, `<` and `>` escaped. */
function plistString(text: string): string {
  return `<string>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`;
}

/**
 * The text of the launch agent of macOS: every hour at `minutes` (StartCalendarInterval; launchd starts a time that the
 * computer missed while it slept once after the wake, and never wakes it), and at the login of the user (RunAtLoad).
 * When the program ends, launchd leaves the processes of its process group (AbandonProcessGroup), so the VM that it
 * started goes on.
 */
export function launchdPlistText(program: VmTaskProgram, minutes: readonly number[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${plistString(VM_TASK_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[program.electron, ...vmTaskArgs(program.paths)].map((word) => `    ${plistString(word)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>ELECTRON_RUN_AS_NODE</key>',
    '    <string>1</string>',
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...minutes.flatMap((minute) => ['    <dict>', '      <key>Minute</key>', `      <integer>${minute}</integer>`, '    </dict>']),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The files of the definition of the task, by the platform: the units of systemd, or the property list of launchd. */
export function vmTaskDefinitionFiles(platform: NodeJS.Platform, homeDir: string): string[] {
  if (platform === 'darwin') return [path.join(homeDir, 'Library', 'LaunchAgents', `${VM_TASK_LABEL}.plist`)];
  const folder = path.join(homeDir, '.config', 'systemd', 'user');
  return [path.join(folder, `${VM_TASK_UNIT}.service`), path.join(folder, `${VM_TASK_UNIT}.timer`)];
}

export interface VmTaskDeps {
  runner: Pick<ProcessRunner, 'run'>;
  logger: Logger;
  platform: NodeJS.Platform;
  homeDir: string;
  /** The files of the task (vmTaskPaths of LimaPaths.root). */
  paths: VmTaskPaths;
  /** dist/vmTask.js of this extension, which the task runs as its copy. */
  bundledProgram: string;
  /** The user ID of this process, for `launchctl … gui/<uid>`. */
  uid: () => number;
  /** For tests. Default: Date.now. */
  now?: () => number;
}

/** What the task gets from Devspaces: its settings, and the Electron of VS Code that runs its program. */
export interface VmTaskWish {
  config: VmTaskConfig;
  electron: string;
}

/**
 * The scheduled task of the user on macOS and Linux. `update` writes the program, the settings and the definition when
 * they differ, and loads a changed definition; `remove` unloads and deletes it. The calls of this window run one after
 * the other. Neither rejects: a failure is logged, and the next update tries again.
 */
export class VmTask {
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VmTaskDeps) {}

  /** Brings the task to `wish`. Only on macOS and Linux. Never rejects. */
  update(wish: VmTaskWish): Promise<void> {
    return this.enqueue(() => this.write(wish), 'could not be written');
  }

  /** Unloads and deletes the task, with its files. Never rejects. */
  remove(): Promise<void> {
    return this.enqueue(() => this.delete(), 'could not be removed');
  }

  private enqueue(task: () => Promise<void>, failure: string): Promise<void> {
    this.work = this.work.then(task).catch((error: unknown) => {
      this.deps.logger.warn(`The scheduled task of the VM of Devspaces ${failure}: ${errorMessage(error)}`);
    });
    return this.work;
  }

  private async write(wish: VmTaskWish): Promise<void> {
    const { platform, homeDir, paths } = this.deps;
    if (platform !== 'darwin' && platform !== 'linux') return;
    const schedule = parseCacheSchedule(wish.config.schedule);
    if (schedule === undefined) throw new Error(`the schedule "${wish.config.schedule}" is not valid`);
    await fs.promises.mkdir(paths.folder, { recursive: true });
    await writeIfChanged(paths.program, await fs.promises.readFile(this.deps.bundledProgram, 'utf8'));
    await writeIfChanged(paths.config, `${JSON.stringify(wish.config, null, 2)}\n`);
    // A new task does not start the VM at once: it counts from now.
    if (!(await exists(paths.stamp))) await fs.promises.writeFile(paths.stamp, vmTaskStampText((this.deps.now ?? Date.now)()));
    const program: VmTaskProgram = { electron: wish.electron, paths };
    const minutes = vmTaskTriggerMinutes(schedule);
    const [first, second] = vmTaskDefinitionFiles(platform, homeDir);
    if (platform === 'darwin') {
      if (await writeIfChanged(first, launchdPlistText(program, minutes))) await this.loaded([first], () => this.loadLaunchAgent(first));
      return;
    }
    const service = await writeIfChanged(first, systemdServiceText(program));
    const timer = await writeIfChanged(second, systemdTimerText(minutes));
    if (service || timer) await this.loaded([first, second], () => this.loadSystemdTimer());
  }

  /**
   * Runs `load`, which loads the written definition `files`. When it fails, the files go, so that the next update writes
   * and loads them again (it loads only what changed).
   */
  private async loaded(files: string[], load: () => Promise<void>): Promise<void> {
    try {
      await load();
    } catch (error) {
      for (const file of files) await fs.promises.rm(file, { force: true });
      throw error;
    }
  }

  private async delete(): Promise<void> {
    const { platform, homeDir, paths } = this.deps;
    if (platform !== 'darwin' && platform !== 'linux') return;
    const files = vmTaskDefinitionFiles(platform, homeDir);
    if (!(await Promise.all(files.map(exists))).some(Boolean) && !(await exists(paths.folder))) return;
    if (platform === 'darwin') await this.launchctl(['bootout', `gui/${this.deps.uid()}/${VM_TASK_LABEL}`], true);
    else await this.systemctl(['disable', '--now', `${VM_TASK_UNIT}.timer`], true);
    for (const file of files) await fs.promises.rm(file, { force: true });
    if (platform === 'linux') await this.systemctl(['daemon-reload'], true);
    await fs.promises.rm(paths.folder, { recursive: true, force: true });
    this.deps.logger.info('Devspaces removed its scheduled task, which started the VM of Devspaces at the times of devspaces.cacheUpdateSchedule.');
  }

  /** Loads the launch agent `file` again: its old version goes first (bootout fails when none is loaded). */
  private async loadLaunchAgent(file: string): Promise<void> {
    const domain = `gui/${this.deps.uid()}`;
    await this.launchctl(['bootout', `${domain}/${VM_TASK_LABEL}`], true);
    await this.launchctl(['bootstrap', domain, file], false);
    this.deps.logger.info(`Devspaces wrote its scheduled task ${file}: it starts the VM of Devspaces at the times of devspaces.cacheUpdateSchedule.`);
  }

  /** Reads the units again and starts the timer (enable: also at the next login). */
  private async loadSystemdTimer(): Promise<void> {
    await this.systemctl(['daemon-reload'], false);
    await this.systemctl(['enable', `${VM_TASK_UNIT}.timer`], false);
    // `restart` so that a changed timer counts with its new times.
    await this.systemctl(['restart', `${VM_TASK_UNIT}.timer`], false);
    this.deps.logger.info(`Devspaces wrote its scheduled task ${VM_TASK_UNIT}.timer (systemd of the user): it starts the VM of Devspaces at the times of devspaces.cacheUpdateSchedule.`);
  }

  private launchctl(args: string[], mayFail: boolean): Promise<void> {
    return this.call('launchctl', args, mayFail);
  }

  private systemctl(args: string[], mayFail: boolean): Promise<void> {
    return this.call('systemctl', ['--user', ...args], mayFail);
  }

  private async call(file: string, args: string[], mayFail: boolean): Promise<void> {
    const result = await this.deps.runner.run(file, args, { timeoutMs: TASK_CALL_TIMEOUT_MS });
    if (mayFail || (result.exitCode === 0 && !result.timedOut)) return;
    const output = (result.stderr || result.stdout).trim();
    throw new Error(`${file} ${args.join(' ')} ${result.timedOut ? `did not end within ${TASK_CALL_TIMEOUT_MS / 1000} seconds` : `ended with exit code ${result.exitCode}`}${output ? `: ${output}` : ''}`);
  }
}

/** Writes `text` into `file` when the file has another text; true when it wrote. */
async function writeIfChanged(file: string, text: string): Promise<boolean> {
  const before = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
  if (before === text) return false;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Through a new file and a rename, so that the program never reads half a file.
  const part = `${file}.${process.pid}.part`;
  await fs.promises.writeFile(part, text);
  await fs.promises.rename(part, file);
  return true;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}
