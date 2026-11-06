// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scheduled task of the user on macOS and Linux (R-VM-005): its trigger, its definition for systemd and launchd,
// when its program starts the VM, and the writes of a window, which change only what differs. The home folder is a
// temporary folder, and `systemctl` and `launchctl` are fakes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import { parseCacheSchedule } from '../remoteMonitor/cacheSettings';
import {
  RUN_AS_NODE_ARG,
  VM_TASK_LABEL,
  VmTask,
  launchdPlistText,
  parseVmTaskConfig,
  parseVmTaskStamp,
  systemdServiceText,
  systemdTimerText,
  vmTaskArgs,
  vmTaskDefinitionFiles,
  vmTaskDue,
  vmTaskPaths,
  vmTaskStampText,
  vmTaskTriggerMinutes,
  vscodeElectron,
  type VmTaskConfig,
} from './vmTask';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-06T10:00:00Z');
const schedule = (text: string) => parseCacheSchedule(text)!;

describe('the trigger of the task', () => {
  it('wakes the program every hour at the minute of a cron schedule, and every 15 minutes for an interval', () => {
    expect(vmTaskTriggerMinutes(schedule('7 6 * * *'))).toEqual([7]);
    expect(vmTaskTriggerMinutes(schedule('30 */3 * * 1-5'))).toEqual([30]);
    expect(vmTaskTriggerMinutes(schedule('0 * * * *'))).toEqual([0]);
    expect(vmTaskTriggerMinutes(schedule('120'))).toEqual([0, 15, 30, 45]);
  });
});

describe('when the program starts the VM', () => {
  const config = { schedule: '7 6 * * *', timeZone: 'UTC' };
  const at = (iso: string) => Date.parse(iso);

  it('after a time of the schedule that passed since the last start, in the time zone of the settings', () => {
    expect(vmTaskDue(config, at('2026-11-06T06:00:00Z'), at('2026-11-06T06:06:59Z'))).toBe(false);
    expect(vmTaskDue(config, at('2026-11-06T06:00:00Z'), at('2026-11-06T06:07:00Z'))).toBe(true);
    // A computer that was off for days starts it once at the login.
    expect(vmTaskDue(config, at('2026-11-01T06:10:00Z'), at('2026-11-06T09:00:00Z'))).toBe(true);
    expect(vmTaskDue(config, at('2026-11-06T06:10:00Z'), at('2026-11-07T06:06:00Z'))).toBe(false);
    // 06:07 in Vienna is 05:07 UTC in November.
    expect(vmTaskDue({ ...config, timeZone: 'Europe/Vienna' }, at('2026-11-06T05:00:00Z'), at('2026-11-06T05:07:00Z'))).toBe(true);
  });

  it('for an interval, when the minutes passed since the last start', () => {
    expect(vmTaskDue({ schedule: '120', timeZone: 'UTC' }, T0, T0 + 2 * HOUR - 1)).toBe(false);
    expect(vmTaskDue({ schedule: '120', timeZone: 'UTC' }, T0, T0 + 2 * HOUR)).toBe(true);
  });

  it('never without a last start, and never with a schedule that is not valid', () => {
    expect(vmTaskDue(config, undefined, T0)).toBe(false);
    expect(vmTaskDue({ schedule: '5', timeZone: 'UTC' }, T0 - 48 * HOUR, T0)).toBe(false);
  });

  it('reads its settings and its stamp, and refuses what is not complete', () => {
    const full: VmTaskConfig = { schedule: '60', timeZone: 'UTC', limactl: '/l/bin/limactl', limaHome: '/h/vm' };
    expect(parseVmTaskConfig(JSON.stringify(full))).toEqual(full);
    expect(parseVmTaskConfig(JSON.stringify({ ...full, limactl: 1 }))).toBeUndefined();
    expect(parseVmTaskConfig('{')).toBeUndefined();
    expect(parseVmTaskStamp(vmTaskStampText(T0))).toBe(T0);
    expect(parseVmTaskStamp('{"lastStartAt":"x"}')).toBeUndefined();
    expect(parseVmTaskStamp('')).toBeUndefined();
  });
});

describe('the definition of the task', () => {
  const paths = vmTaskPaths('/home/me/.nimblescape/devspaces');
  const program = { electron: '/usr/share/code/code', paths };

  it('runs the program with the Electron of VS Code as Node.js, with the settings file', () => {
    expect(paths).toEqual({
      folder: '/home/me/.nimblescape/devspaces/task',
      program: '/home/me/.nimblescape/devspaces/task/vmTask.js',
      config: '/home/me/.nimblescape/devspaces/task/task.json',
      stamp: '/home/me/.nimblescape/devspaces/task/last-start.json',
      log: '/home/me/.nimblescape/devspaces/task/task.log',
    });
    // As the `code` command of VS Code: the flag after the script.
    expect(vmTaskArgs(paths)).toEqual([paths.program, RUN_AS_NODE_ARG, paths.config]);
  });

  it('for systemd: a oneshot service with ELECTRON_RUN_AS_NODE, and a persistent timer that never wakes the computer', () => {
    const service = systemdServiceText(program);
    expect(service).toContain('\nType=oneshot\n');
    expect(service).toContain('\nEnvironment=ELECTRON_RUN_AS_NODE=1\n');
    expect(service).toContain(`\nExecStart="/usr/share/code/code" "${paths.program}" "${RUN_AS_NODE_ARG}" "${paths.config}"\n`);
    const timer = systemdTimerText([7]);
    expect(timer).toContain('\nOnCalendar=*-*-* *:07:00\nPersistent=true\n');
    expect(timer).not.toContain('WakeSystem');
    expect(systemdTimerText([0, 15, 30, 45])).toContain('\nOnCalendar=*-*-* *:00,15,30,45:00\n');
  });

  // Mutation: a path with a quote, a percent sign or a dollar sign that is not escaped fails it.
  it('for systemd: quotes every word, and escapes what systemd would read as its own', () => {
    const odd = systemdServiceText({ electron: '/opt/My "Code"/100%/$HOME\\code', paths });
    expect(odd).toContain('ExecStart="/opt/My \\"Code\\"/100%%/$$HOME\\\\code" ');
  });

  it('for launchd: the program with ELECTRON_RUN_AS_NODE, every hour at the minutes, and at the login; the VM goes on after the program', () => {
    const plist = launchdPlistText({ electron: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', paths }, [7]);
    expect(plist).toContain(`<key>Label</key>\n  <string>${VM_TASK_LABEL}</string>`);
    expect(plist).toContain(
      `<array>\n    <string>/Applications/Visual Studio Code.app/Contents/MacOS/Electron</string>\n    <string>${paths.program}</string>\n    <string>${RUN_AS_NODE_ARG}</string>\n    <string>${paths.config}</string>\n  </array>`,
    );
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>');
    expect(plist).toContain('<key>StartCalendarInterval</key>\n  <array>\n    <dict>\n      <key>Minute</key>\n      <integer>7</integer>\n    </dict>\n  </array>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    // launchd leaves the processes of the process group of the program when it ends: the VM that it started.
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    expect(launchdPlistText({ electron: '/A&B/<x>', paths }, [0])).toContain('<string>/A&amp;B/&lt;x&gt;</string>');
  });

  it('lives in the folders of the user', () => {
    expect(vmTaskDefinitionFiles('linux', '/home/me')).toEqual(['/home/me/.config/systemd/user/devspaces-vm.service', '/home/me/.config/systemd/user/devspaces-vm.timer']);
    expect(vmTaskDefinitionFiles('darwin', '/Users/me')).toEqual([`/Users/me/Library/LaunchAgents/${VM_TASK_LABEL}.plist`]);
  });

  it('runs the program of the macOS app as the `code` command does, else the program of this process', () => {
    const appRoot = '/Applications/Visual Studio Code.app/Contents/Resources/app';
    const helper = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';
    expect(vscodeElectron('darwin', appRoot, helper, () => true)).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
    expect(vscodeElectron('darwin', appRoot, helper, () => false)).toBe(helper);
    expect(vscodeElectron('linux', '/usr/share/code/resources/app', '/usr/share/code/code', () => true)).toBe('/usr/share/code/code');
  });
});

describe('VmTask', () => {
  let home: string;
  let calls: string[];
  let failing: string | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-vm-task-'));
    calls = [];
    failing = undefined;
    fs.mkdirSync(path.join(home, 'dist'));
    fs.writeFileSync(path.join(home, 'dist', 'vmTask.js'), 'program 1\n');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function task(platform: NodeJS.Platform) {
    const root = path.join(home, '.nimblescape', 'devspaces');
    const paths = vmTaskPaths(root);
    const subject = new VmTask({
      runner: {
        run: async (file: string, args: readonly string[], _options?: RunOptions): Promise<RunResult> => {
          const call = `${file} ${args.join(' ')}`;
          calls.push(call);
          return { exitCode: failing !== undefined && call.includes(failing) ? 1 : 0, stdout: '', stderr: failing !== undefined && call.includes(failing) ? 'Failed to connect to bus' : '', timedOut: false };
        },
      },
      logger,
      platform,
      homeDir: home,
      paths,
      bundledProgram: path.join(home, 'dist', 'vmTask.js'),
      uid: () => 501,
      now: () => T0,
    });
    return { subject, paths, root };
  }

  const wish = (scheduleText: string, electron = '/usr/share/code/code') => ({
    config: { schedule: scheduleText, timeZone: 'Europe/Vienna', limactl: '/l/2.2.1/bin/limactl', limaHome: '/h/vm' },
    electron,
  });

  it('on Linux: writes the program, the settings, the stamp and the units, and starts the timer', async () => {
    const { subject, paths } = task('linux');
    await subject.update(wish('7 6 * * *'));
    expect(fs.readFileSync(paths.program, 'utf8')).toBe('program 1\n');
    expect(parseVmTaskConfig(fs.readFileSync(paths.config, 'utf8'))).toEqual(wish('7 6 * * *').config);
    // A new task counts from now: it does not start the VM at once.
    expect(parseVmTaskStamp(fs.readFileSync(paths.stamp, 'utf8'))).toBe(T0);
    const [service, timer] = vmTaskDefinitionFiles('linux', home);
    expect(fs.readFileSync(service, 'utf8')).toBe(systemdServiceText({ electron: '/usr/share/code/code', paths }));
    expect(fs.readFileSync(timer, 'utf8')).toBe(systemdTimerText([7]));
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable devspaces-vm.timer', 'systemctl --user restart devspaces-vm.timer']);
    expect(fs.readdirSync(paths.folder).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('writes nothing and loads nothing when nothing changed; a new schedule time changes the settings only', async () => {
    const { subject, paths } = task('linux');
    await subject.update(wish('7 6 * * *'));
    calls = [];
    fs.writeFileSync(paths.stamp, vmTaskStampText(T0 - HOUR));
    await subject.update(wish('7 6 * * *'));
    expect(calls).toEqual([]);
    // Another hour with the same minute: the trigger stays, the program reads the new settings at its next start.
    await subject.update(wish('7 18 * * *'));
    expect(calls).toEqual([]);
    expect(parseVmTaskConfig(fs.readFileSync(paths.config, 'utf8'))?.schedule).toBe('7 18 * * *');
    // The stamp of the program stays.
    expect(parseVmTaskStamp(fs.readFileSync(paths.stamp, 'utf8'))).toBe(T0 - HOUR);
  });

  it('loads the timer again for another minute, another Electron of VS Code, and writes a new program', async () => {
    const { subject, paths } = task('linux');
    await subject.update(wish('7 6 * * *'));
    calls = [];
    await subject.update(wish('120'));
    expect(fs.readFileSync(vmTaskDefinitionFiles('linux', home)[1], 'utf8')).toBe(systemdTimerText([0, 15, 30, 45]));
    expect(calls).toHaveLength(3);
    calls = [];
    await subject.update(wish('120', '/snap/code/200/usr/share/code/code'));
    expect(calls).toHaveLength(3);
    calls = [];
    fs.writeFileSync(path.join(home, 'dist', 'vmTask.js'), 'program 2\n');
    await subject.update(wish('120', '/snap/code/200/usr/share/code/code'));
    expect(fs.readFileSync(paths.program, 'utf8')).toBe('program 2\n');
    expect(calls).toEqual([]);
  });

  it('on macOS: writes the launch agent and loads it again in the domain of the user', async () => {
    const { subject, paths } = task('darwin');
    const electron = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
    await subject.update(wish('7 6 * * *', electron));
    const [plist] = vmTaskDefinitionFiles('darwin', home);
    expect(fs.readFileSync(plist, 'utf8')).toBe(launchdPlistText({ electron, paths }, [7]));
    expect(calls).toEqual([`launchctl bootout gui/501/${VM_TASK_LABEL}`, `launchctl bootstrap gui/501 ${plist}`]);
    calls = [];
    await subject.update(wish('7 6 * * *', electron));
    expect(calls).toEqual([]);
  });

  it('does nothing on Windows', async () => {
    const { subject, paths } = task('win32');
    await subject.update(wish('7 6 * * *'));
    expect(fs.existsSync(paths.folder)).toBe(false);
    expect(calls).toEqual([]);
  });

  // Mutation: a failed load that keeps the written units fails it (the next update would find nothing changed and load
  // nothing).
  it('logs a failure, and the next update tries again, also with the same settings', async () => {
    const { subject } = task('linux');
    failing = 'enable';
    await subject.update(wish('7 6 * * *'));
    expect(logger.warn).toHaveBeenCalledWith(
      'The scheduled task of the VM of Devspaces could not be written: systemctl --user enable devspaces-vm.timer ended with exit code 1: Failed to connect to bus',
    );
    for (const file of vmTaskDefinitionFiles('linux', home)) expect(fs.existsSync(file), file).toBe(false);
    failing = undefined;
    calls = [];
    await expect(subject.update(wish('7 6 * * *'))).resolves.toBeUndefined();
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable devspaces-vm.timer', 'systemctl --user restart devspaces-vm.timer']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The same for the launch agent of macOS.
    const mac = task('darwin');
    failing = 'bootstrap';
    await mac.subject.update(wish('7 6 * * *'));
    expect(fs.existsSync(vmTaskDefinitionFiles('darwin', home)[0])).toBe(false);
    failing = undefined;
    calls = [];
    await mac.subject.update(wish('7 6 * * *'));
    expect(calls).toEqual([`launchctl bootout gui/501/${VM_TASK_LABEL}`, `launchctl bootstrap gui/501 ${vmTaskDefinitionFiles('darwin', home)[0]}`]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    await subject.update({ ...wish('7 6 * * *'), config: { ...wish('7 6 * * *').config, schedule: '5' } });
    expect(logger.warn).toHaveBeenLastCalledWith('The scheduled task of the VM of Devspaces could not be written: the schedule "5" is not valid');
  });

  it('removes the definition and the folder of the task, and stops the timer first', async () => {
    const { subject, paths } = task('linux');
    await subject.update(wish('7 6 * * *'));
    calls = [];
    await subject.remove();
    expect(calls).toEqual(['systemctl --user disable --now devspaces-vm.timer', 'systemctl --user daemon-reload']);
    for (const file of [...vmTaskDefinitionFiles('linux', home), paths.folder]) expect(fs.existsSync(file), file).toBe(false);
    // Nothing to remove: no call.
    calls = [];
    await subject.remove();
    expect(calls).toEqual([]);
    const mac = task('darwin');
    await mac.subject.update(wish('7 6 * * *'));
    calls = [];
    await mac.subject.remove();
    expect(calls).toEqual([`launchctl bootout gui/501/${VM_TASK_LABEL}`]);
    expect(fs.existsSync(vmTaskDefinitionFiles('darwin', home)[0])).toBe(false);
  });
});
