// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scheduled task of the Windows user that starts the WSL distribution of Devspaces (R-VM-005): its triggers for
// cron schedules and intervals, its script and command line, its definition for Task Scheduler, and the registrations
// of a window, which change only what differs. The folder of the record is a temporary folder, and `whoami.exe` and
// `schtasks.exe` are fakes.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import { parseCacheSchedule } from '../remoteMonitor/cacheSettings';
import {
  WSL_TASK_DOCKER_TRIES,
  WSL_TASK_LOG,
  WSL_TASK_LOG_LINES,
  WSL_TASK_NAME_PREFIX,
  WslTask,
  delayedTime,
  parseWhoamiSid,
  system32Program,
  wslTaskArguments,
  wslTaskFileBytes,
  wslTaskName,
  wslTaskScript,
  wslTaskTriggers,
  wslTaskXml,
} from './wslTask';
import { KEEPER_SCRIPT } from './wslKeeper';

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const WSLG = 'C:\\Program Files\\WSL\\wslg.exe';
const WSL = 'C:\\Windows\\System32\\wsl.exe';
const SETTINGS = { schedule: '7 6 * * *', timeZone: 'Europe/Vienna' };
const schedule = (text: string) => parseCacheSchedule(text)!;

/** The start boundaries of `triggers`, as the times of the day. */
function times(triggers: readonly string[]): string[] {
  return triggers.map((trigger) => /<StartBoundary>2026-01-01T(\d\d:\d\d):00<\/StartBoundary>/.exec(trigger)?.[1] ?? '?');
}

/** The element `<name>` of `trigger` with its content (the first one), or undefined. */
function element(trigger: string, name: string): string | undefined {
  return new RegExp(`<${name}>.*?</${name}>`).exec(trigger)?.[0];
}

describe('the name and the user of the task', () => {
  it('names the task in the root folder with the SID of the Windows user', () => {
    expect(wslTaskName(SID)).toBe(`${WSL_TASK_NAME_PREFIX} ${SID}`);
    expect(wslTaskName(SID)).toBe('nimblescape Devspaces WSL S-1-5-21-1004336348-1177238915-682003330-1001');
  });

  it('reads the SID from the output of whoami /user /fo csv /nh', () => {
    expect(parseWhoamiSid(`"desktop-7k2\\hannes","${SID}"\r\n`)).toBe(SID);
    expect(parseWhoamiSid(`"AzureAD\\Hannes Stauss","S-1-12-1-1-2-3-4"\r\n`)).toBe('S-1-12-1-1-2-3-4');
    expect(parseWhoamiSid('')).toBeUndefined();
    expect(parseWhoamiSid('"desktop-7k2\\hannes","S-1"\r\n')).toBeUndefined();
    expect(parseWhoamiSid('ERROR: Access is denied.')).toBeUndefined();
  });
});

describe('the triggers of the task', () => {
  it('starts a time of the schedule 5 minutes later on the same day, and a time near midnight at that time', () => {
    expect(delayedTime({ hour: 6, minute: 7 })).toEqual({ hour: 6, minute: 12 });
    expect(delayedTime({ hour: 10, minute: 58 })).toEqual({ hour: 11, minute: 3 });
    expect(delayedTime({ hour: 23, minute: 54 })).toEqual({ hour: 23, minute: 59 });
    expect(delayedTime({ hour: 23, minute: 55 })).toEqual({ hour: 23, minute: 55 });
    expect(delayedTime({ hour: 23, minute: 59 })).toEqual({ hour: 23, minute: 59 });
  });

  it('has one daily trigger for the default schedule, 5 minutes after 06:07', () => {
    const triggers = wslTaskTriggers(schedule('7 6 * * *'));
    expect(triggers).toEqual(['<CalendarTrigger><StartBoundary>2026-01-01T06:12:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>']);
  });

  it('has one trigger per hour of the schedule at its minute, on the days of the week', () => {
    const triggers = wslTaskTriggers(schedule('30 */3 * * 1-5'));
    expect(times(triggers)).toEqual(['00:35', '03:35', '06:35', '09:35', '12:35', '15:35', '18:35', '21:35']);
    for (const trigger of triggers) {
      expect(element(trigger, 'ScheduleByWeek')).toBe('<ScheduleByWeek><DaysOfWeek><Monday /><Tuesday /><Wednesday /><Thursday /><Friday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>');
    }
  });

  it('names the days of the month and all months for a schedule of days of the month', () => {
    const [trigger, ...rest] = wslTaskTriggers(schedule('0 4 1,15 * *'));
    expect(rest).toEqual([]);
    expect(times([trigger])).toEqual(['04:05']);
    expect(element(trigger, 'DaysOfMonth')).toBe('<DaysOfMonth><Day>1</Day><Day>15</Day></DaysOfMonth>');
    expect(element(trigger, 'Months')).toBe('<Months><January /><February /><March /><April /><May /><June /><July /><August /><September /><October /><November /><December /></Months>');
  });

  it('names all days of the month in the months of a schedule that limits only the months', () => {
    const [trigger, ...rest] = wslTaskTriggers(schedule('0 4 * 1,7 *'));
    expect(rest).toEqual([]);
    expect(element(trigger, 'DaysOfMonth')).toBe(`<DaysOfMonth>${Array.from({ length: 31 }, (_, index) => `<Day>${index + 1}</Day>`).join('')}</DaysOfMonth>`);
    expect(element(trigger, 'Months')).toBe('<Months><January /><July /></Months>');
  });

  it('names the days of the week in every week of the months of a schedule that limits both', () => {
    const [trigger, ...rest] = wslTaskTriggers(schedule('0 4 * 1,7 1'));
    expect(rest).toEqual([]);
    expect(element(trigger, 'ScheduleByMonthDayOfWeek')).toBe(
      '<ScheduleByMonthDayOfWeek><Weeks><Week>1</Week><Week>2</Week><Week>3</Week><Week>4</Week><Week>Last</Week></Weeks><DaysOfWeek><Monday /></DaysOfWeek><Months><January /><July /></Months></ScheduleByMonthDayOfWeek>',
    );
  });

  it('has a trigger for the days of the month and one for the days of the week when the schedule names both, as cron', () => {
    const triggers = wslTaskTriggers(schedule('0 4 13 * 5'));
    expect(triggers).toHaveLength(2);
    expect(element(triggers[0], 'ScheduleByMonth')).toContain('<DaysOfMonth><Day>13</Day></DaysOfMonth>');
    expect(element(triggers[1], 'ScheduleByWeek')).toBe('<ScheduleByWeek><DaysOfWeek><Friday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>');
  });

  it('stays within the 48 triggers of Task Scheduler for every hour on two kinds of days', () => {
    expect(wslTaskTriggers(schedule('0 * * * *'))).toHaveLength(24);
    expect(wslTaskTriggers(schedule('0 * 13 * 5'))).toHaveLength(48);
  });

  it('keeps a time near midnight on its day', () => {
    expect(times(wslTaskTriggers(schedule('58 23 * * 0')))).toEqual(['23:58']);
  });

  it('repeats a daily trigger from 00:05 for an interval, and has one daily trigger for an interval of a day', () => {
    expect(wslTaskTriggers(schedule('90'))).toEqual([
      '<CalendarTrigger><Repetition><Interval>PT90M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:05:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>',
    ]);
    expect(wslTaskTriggers(schedule('1440'))).toEqual(['<CalendarTrigger><StartBoundary>2026-01-01T00:05:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>']);
  });
});

describe('the script and the command line of the task', () => {
  it('starts the Monitor, gives it the settings in base64, logs each step, and ends with the keeper', () => {
    const script = wslTaskScript({ ...SETTINGS, permanent: true } as typeof SETTINGS);
    const parts = script.split(';');
    expect(parts[0]).toBe('set -f');
    expect(script).toContain(`exec >>${WSL_TASK_LOG} 2>&1`);
    expect(script).toContain('timeout 120 docker start devspaces-monitor >/dev/null');
    expect(script).toContain('docker exec -i devspaces-monitor node /opt/devspace/monitor.js settings -');
    expect(script.endsWith(KEEPER_SCRIPT)).toBe(true);
    const input = /echo ([A-Za-z0-9+/=]+)\|base64 -d/.exec(script)?.[1];
    expect(JSON.parse(Buffer.from(input ?? '', 'base64').toString('utf8'))).toEqual(SETTINGS);
    expect(script).toContain("schedule '7 6 * * *' '(Europe/Vienna)'.");
  });

  it('has no double quote, backslash or percent sign, also for unusual text in the settings', () => {
    for (const settings of [SETTINGS, { schedule: '0 */4 * * MON-FRI', timeZone: 'America/Argentina/Buenos_Aires' }, { schedule: '7 6 * * *', timeZone: 'a"b\\c%d\'e' }]) {
      const script = wslTaskScript(settings);
      expect(script).not.toMatch(/["\\%]/);
      expect(script).not.toContain('\n');
    }
    expect(wslTaskScript({ schedule: '7 6 * * *', timeZone: 'a"b\\c%d\'e' })).toContain("'(a?b?c?d?e)'.");
  });

  it('stays far below the 4000 characters that Task Scheduler takes for the arguments, also with a long schedule', () => {
    const long = { schedule: '0 0,3,6,9,12,15,18,21 1,8,15,22,29 1,2,3,4,5,6,7,8,9,10,11,12 MON,TUE,WED,THU,FRI', timeZone: 'America/Argentina/ComodRivadavia' };
    expect(wslTaskArguments(WSLG, wslTaskScript(long)).length).toBeLessThan(2000);
  });

  it('runs the script as root in the distribution of Devspaces with wslg.exe, and with wsl.exe --exec without it', () => {
    expect(wslTaskArguments(WSLG, 'echo hi')).toBe('-d devspaces -u root --cd / --shell-type none sh -c "echo hi"');
    expect(wslTaskArguments('C:\\PROGRA~1\\WSL\\WSLG.EXE', 'echo hi')).toBe('-d devspaces -u root --cd / --shell-type none sh -c "echo hi"');
    expect(wslTaskArguments(WSL, 'echo hi')).toBe('-d devspaces -u root --cd / --exec sh -c "echo hi"');
  });
});

describe('the script of the task in sh', () => {
  let dir: string;
  const file = (name: string) => path.join(dir, name);
  const calls = () => fs.readFileSync(file('calls'), 'utf8').trim().split('\n');
  const logLines = () => fs.readFileSync(file('task.log'), 'utf8').trim().split('\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-wsl-task-script-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Runs the script with a fake `docker` (it answers `docker info` from the call `dockerUpAt` on, and fails `start` or
   * `exec` when asked) and a fake `sleep`, its log in the temporary folder, and a line in place of the keeper.
   */
  function run(options: { dockerUpAt?: number; startFails?: boolean; settingsFails?: boolean } = {}) {
    const bin = file('bin');
    fs.mkdirSync(bin);
    const script = (name: string, lines: string[]) => fs.writeFileSync(path.join(bin, name), ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
    script('docker', [
      `echo "docker $*" >>'${file('calls')}'`,
      'case "$1" in',
      `info) [ "$(grep -c '^docker info' '${file('calls')}')" -ge ${options.dockerUpAt ?? 1} ] || { echo 'Cannot connect to the Docker daemon' >&2; exit 1; };;`,
      `start) ${options.startFails ? "echo 'Error response from daemon: No such container: devspaces-monitor' >&2; exit 1" : 'echo devspaces-monitor'};;`,
      `exec) cat >'${file('settings.json')}'; ${options.settingsFails ? 'exit 1' : 'echo The settings were taken.'};;`,
      'esac',
    ]);
    script('sleep', [`echo "sleep $*" >>'${file('calls')}'`]);
    const full = wslTaskScript(SETTINGS);
    expect(full.endsWith(KEEPER_SCRIPT)).toBe(true);
    const tested = `${full.slice(0, -KEEPER_SCRIPT.length).split(WSL_TASK_LOG).join(file('task.log'))}echo keeper >>'${file('calls')}'`;
    expect(tested).not.toContain('/var/');
    return spawnSync('sh', ['-c', tested], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  }

  it('waits for Docker, starts the Monitor, gives it the settings, logs each step, and runs the keeper', () => {
    const result = run({ dockerUpAt: 3 });
    expect(result.status).toBe(0);
    expect(calls()).toEqual(['docker info', 'sleep 10', 'docker info', 'sleep 10', 'docker info', 'docker start devspaces-monitor', 'docker exec -i devspaces-monitor node /opt/devspace/monitor.js settings -', 'keeper']);
    expect(JSON.parse(fs.readFileSync(file('settings.json'), 'utf8'))).toEqual(SETTINGS);
    const lines = logLines();
    expect(lines).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00 INFO The task starts the Monitor with the schedule 7 6 \* \* \* \(Europe\/Vienna\)\.$/),
      'The settings were taken.',
      expect.stringMatching(/ INFO The Monitor runs\. It does its background run when it is due, and ends when idle\.$/),
    ]);
    expect(result.stdout).toBe('');
  });

  it('starts no Monitor when Docker does not answer, and still runs the keeper', () => {
    run({ dockerUpAt: 100 });
    const made = calls();
    expect(made.filter((call) => call === 'docker info')).toHaveLength(WSL_TASK_DOCKER_TRIES);
    expect(made.filter((call) => call === 'sleep 10')).toHaveLength(WSL_TASK_DOCKER_TRIES - 1);
    expect(made.at(-1)).toBe('keeper');
    expect(made).not.toContain('docker start devspaces-monitor');
    expect(logLines().at(-1)).toMatch(/ WARN Docker did not answer in the distribution, so the task did not start the Monitor\.$/);
  });

  it('says so when the Monitor does not start or does not take the settings', () => {
    run({ startFails: true });
    expect(calls()).toEqual(['docker info', 'docker start devspaces-monitor', 'keeper']);
    expect(logLines().slice(1)).toEqual(['Error response from daemon: No such container: devspaces-monitor', expect.stringMatching(/ WARN The Monitor could not be started\. The next start of a devspace creates it again\.$/)]);
    fs.rmSync(file('bin'), { recursive: true });
    fs.rmSync(file('calls'));
    fs.rmSync(file('task.log'));
    run({ settingsFails: true });
    expect(calls().at(-1)).toBe('keeper');
    expect(logLines().at(-1)).toMatch(/ WARN The Monitor runs, but it did not take the schedule and the time zone\.$/);
  });

  it('keeps the last lines of its log from earlier runs', () => {
    fs.writeFileSync(file('task.log'), Array.from({ length: 400 }, (_, index) => `old ${index + 1}\n`).join(''));
    run();
    const lines = logLines();
    expect(lines.slice(0, WSL_TASK_LOG_LINES)).toEqual(Array.from({ length: WSL_TASK_LOG_LINES }, (_, index) => `old ${index + 101}`));
    expect(lines).toHaveLength(WSL_TASK_LOG_LINES + 3);
    expect(fs.existsSync(`${file('task.log')}.part`)).toBe(false);
  });
});

describe('the definition of the task', () => {
  const xml = wslTaskXml({ sid: SID, program: WSLG, settings: SETTINGS, triggers: wslTaskTriggers(schedule(SETTINGS.schedule)) });

  it('runs as the Windows user while logged on, without administrator rights', () => {
    expect(xml).toContain(`<UserId>${SID}</UserId>`);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain(`<URI>\\${wslTaskName(SID)}</URI>`);
  });

  it('never wakes the computer, runs on battery, has no time limit, starts a missed time, and runs once at a time', () => {
    expect(xml).toContain('<WakeToRun>false</WakeToRun>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<StopOnIdleEnd>false</StopOnIdleEnd>');
  });

  it('has the triggers and the action with the script, escaped for XML', () => {
    expect(xml).toContain(`    ${wslTaskTriggers(schedule(SETTINGS.schedule))[0]}\r\n`);
    expect(xml).toContain(`<Command>"${WSLG}"</Command>`);
    const argumentsText = /<Arguments>(.*)<\/Arguments>/.exec(xml)?.[1] ?? '';
    expect(argumentsText).toContain('&amp;&amp;');
    expect(argumentsText).not.toMatch(/[<>]|&(?!amp;|lt;|gt;)/);
    const unescaped = argumentsText.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(unescaped).toBe(wslTaskArguments(WSLG, wslTaskScript(SETTINGS)));
  });

  it('is a document of Task Scheduler with Windows line ends, and its file is UTF-16 LE with a byte order mark', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n')).toBe(true);
    expect(xml.replace(/\r\n/g, '')).not.toContain('\n');
    expect(xml.endsWith('</Task>\r\n')).toBe(true);
    const bytes = wslTaskFileBytes(xml);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe(xml);
  });

  it('opens and closes each element in order', () => {
    const stack: string[] = [];
    for (const [, closing, name, empty] of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
      if (empty) continue;
      if (closing) expect(stack.pop()).toBe(name);
      else stack.push(name);
    }
    expect(stack).toEqual([]);
  });
});

describe('system32Program', () => {
  it('takes the program from System32 of SystemRoot, not from PATH', () => {
    expect(system32Program({ SystemRoot: 'D:\\Windows' }, 'schtasks.exe')).toBe('D:\\Windows\\System32\\schtasks.exe');
    expect(system32Program({ SYSTEMROOT: 'D:\\Windows' }, 'whoami.exe')).toBe('D:\\Windows\\System32\\whoami.exe');
    expect(system32Program({}, 'schtasks.exe')).toBe('C:\\Windows\\System32\\schtasks.exe');
  });
});

describe('WslTask', () => {
  const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';
  const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
  const NAME = wslTaskName(SID);
  let home: string;
  let folder: string;
  let calls: string[];
  /** The calls (a part of their text) that end with exit code 1. */
  let failing: string[];
  /** The calls (a part of their text) that do not end within their time limit. */
  let timingOut: string[];
  /** The calls (a part of their text) that a signal ends. */
  let signalled: string[];
  let registered: Buffer | undefined;
  let program: string | undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-wsl-task-'));
    folder = path.join(home, 'nimblescape', 'devspaces', 'task');
    calls = [];
    failing = [];
    timingOut = [];
    signalled = [];
    registered = undefined;
    program = WSLG;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function task(): WslTask {
    return new WslTask({
      runner: {
        run: async (file: string, args: readonly string[], options?: RunOptions): Promise<RunResult> => {
          const call = `${file === SCHTASKS ? 'schtasks' : file === WHOAMI ? 'whoami' : file} ${args.join(' ')}`;
          calls.push(call);
          expect(options?.timeoutMs).toBe(30_000);
          if (timingOut.some((text) => call.includes(text))) return { exitCode: null, stdout: '', stderr: '', timedOut: true };
          if (signalled.some((text) => call.includes(text))) return { exitCode: null, stdout: '', stderr: '', timedOut: false };
          if (failing.some((text) => call.includes(text))) return { exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.', timedOut: false };
          if (file === WHOAMI) return { exitCode: 0, stdout: `"desktop-7k2\\hannes","${SID}"\r\n`, stderr: '', timedOut: false };
          if (args[0] === '/Create') registered = fs.readFileSync(args[4]);
          if (args[0] === '/Delete') registered = undefined;
          if (args[0] === '/Query' && registered === undefined) return { exitCode: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.', timedOut: false };
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      },
      logger,
      env: { SystemRoot: 'C:\\Windows' },
      folder,
      program: () => program,
    });
  }

  const recordFile = () => path.join(folder, 'task.xml');
  // Through a function, so that TypeScript does not narrow it after an assignment in a test.
  const lastRegistered = (): Buffer | undefined => registered;
  const expectedBytes = (settings = SETTINGS) => wslTaskFileBytes(wslTaskXml({ sid: SID, program: WSLG, settings, triggers: wslTaskTriggers(schedule(settings.schedule)) }));

  it('registers the definition from a file of its own, which becomes the record', async () => {
    const subject = task();
    expect(subject.file).toBe(recordFile());
    await subject.update(SETTINGS);
    expect(calls).toEqual(['whoami /user /fo csv /nh', `schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`]);
    expect(lastRegistered()?.equals(expectedBytes())).toBe(true);
    expect(fs.readFileSync(recordFile()).equals(expectedBytes())).toBe(true);
    expect(fs.readdirSync(folder)).toEqual(['task.xml']);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Devspaces wrote its scheduled task "${NAME}"`));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('only looks whether the task exists when the definition is the same, and asks for the SID once per window', async () => {
    const subject = task();
    await subject.update(SETTINGS);
    calls = [];
    await subject.update(SETTINGS);
    expect(calls).toEqual([`schtasks /Query /TN ${NAME}`]);
    // Another window: the record is the same.
    calls = [];
    await task().update(SETTINGS);
    expect(calls).toEqual(['whoami /user /fo csv /nh', `schtasks /Query /TN ${NAME}`]);
  });

  it('registers the task again when it is gone, and when the settings changed', async () => {
    const subject = task();
    await subject.update(SETTINGS);
    registered = undefined;
    calls = [];
    await subject.update(SETTINGS);
    expect(calls).toEqual([`schtasks /Query /TN ${NAME}`, `schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`]);
    calls = [];
    const changed = { schedule: '0 */4 * * *', timeZone: 'Europe/Vienna' };
    await subject.update(changed);
    expect(calls).toEqual([`schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`]);
    expect(lastRegistered()?.equals(expectedBytes(changed))).toBe(true);
    expect(fs.readFileSync(recordFile()).equals(expectedBytes(changed))).toBe(true);
  });

  it('keeps the record of the registered task when Task Scheduler refuses a definition, and tries again at the next update', async () => {
    const subject = task();
    await subject.update(SETTINGS);
    failing = ['/Create'];
    const changed = { schedule: '0 */4 * * *', timeZone: 'Europe/Vienna' };
    await expect(subject.update(changed)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('The scheduled task of the WSL distribution of Devspaces could not be written: schtasks /Create ended with exit code 1: ERROR: Access is denied.');
    expect(fs.readFileSync(recordFile()).equals(expectedBytes())).toBe(true);
    expect(fs.readdirSync(folder)).toEqual(['task.xml']);
    failing = [];
    calls = [];
    await subject.update(changed);
    expect(calls).toEqual([`schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`]);
    expect(fs.readFileSync(recordFile()).equals(expectedBytes(changed))).toBe(true);
  });

  it('leaves no record when the first registration fails', async () => {
    failing = ['/Create'];
    await task().update(SETTINGS);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('runs wsl.exe without wslg.exe, and registers nothing without WSL, without the SID or with a schedule that is not valid', async () => {
    program = WSL;
    await task().update(SETTINGS);
    expect(fs.readFileSync(recordFile()).subarray(2).toString('utf16le')).toContain(`<Command>"${WSL}"</Command>`);
    fs.rmSync(recordFile());
    calls = [];
    program = undefined;
    await task().update(SETTINGS);
    expect(logger.warn).toHaveBeenLastCalledWith('The scheduled task of the WSL distribution of Devspaces could not be written: WSL is not installed');
    program = WSLG;
    await task().update({ schedule: '* * * * *', timeZone: 'UTC' });
    expect(logger.warn).toHaveBeenLastCalledWith('The scheduled task of the WSL distribution of Devspaces could not be written: the schedule "* * * * *" is not valid');
    expect(calls).toEqual([]);
    failing = ['whoami'];
    await task().update(SETTINGS);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'The scheduled task of the WSL distribution of Devspaces could not be written: whoami /user did not name the SID of the user (ended with exit code 1: ERROR: Access is denied.)',
    );
    expect(calls).toEqual(['whoami /user /fo csv /nh']);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('removes the task and its record, and calls nothing without a record', async () => {
    const subject = task();
    await subject.remove();
    expect(calls).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
    await subject.update(SETTINGS);
    calls = [];
    vi.clearAllMocks();
    await subject.remove();
    expect(calls).toEqual([`schtasks /Query /TN ${NAME}`, `schtasks /Delete /TN ${NAME} /F`]);
    expect(registered).toBeUndefined();
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Devspaces removed its scheduled task'));
  });

  it('removes only the record when the task is gone, and keeps it when Task Scheduler does not delete the task', async () => {
    const subject = task();
    await subject.update(SETTINGS);
    failing = ['/Delete'];
    await expect(subject.remove()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('The scheduled task of the WSL distribution of Devspaces could not be removed: schtasks /Delete ended with exit code 1: ERROR: Access is denied.');
    expect(fs.existsSync(recordFile())).toBe(true);
    failing = [];
    registered = undefined;
    calls = [];
    await subject.remove();
    expect(calls).toEqual([`schtasks /Query /TN ${NAME}`]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('keeps the record when schtasks /Query does not end, because that does not tell whether the task exists', async () => {
    const subject = task();
    await subject.update(SETTINGS);
    timingOut = ['/Query'];
    calls = [];
    await subject.remove();
    expect(calls).toEqual([`schtasks /Query /TN ${NAME}`]);
    expect(logger.warn).toHaveBeenCalledWith('The scheduled task of the WSL distribution of Devspaces could not be removed: schtasks /Query did not end within 30 seconds');
    expect(fs.existsSync(recordFile())).toBe(true);
    expect(lastRegistered()).toBeDefined();
    timingOut = [];
    signalled = ['/Query'];
    await subject.remove();
    expect(logger.warn).toHaveBeenLastCalledWith('The scheduled task of the WSL distribution of Devspaces could not be removed: schtasks /Query was ended by a signal');
    expect(fs.existsSync(recordFile())).toBe(true);
  });

  it('registers the task again when schtasks /Query does not end at an update', async () => {
    const subject = task();
    await subject.update(SETTINGS);
    timingOut = ['/Query'];
    calls = [];
    await subject.update(SETTINGS);
    expect(calls).toEqual([`schtasks /Query /TN ${NAME}`, `schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('runs the calls of a window one after the other', async () => {
    const subject = task();
    const first = subject.update(SETTINGS);
    const second = subject.remove();
    const third = subject.update(SETTINGS);
    await Promise.all([first, second, third]);
    expect(calls).toEqual([
      'whoami /user /fo csv /nh',
      `schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`,
      `schtasks /Query /TN ${NAME}`,
      `schtasks /Delete /TN ${NAME} /F`,
      `schtasks /Create /TN ${NAME} /XML ${recordFile()}.${process.pid}.part /F`,
    ]);
    expect(lastRegistered()?.equals(expectedBytes())).toBe(true);
  });
});
