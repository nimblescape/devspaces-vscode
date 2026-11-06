// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The scheduled task of the Windows user that starts the WSL distribution of Devspaces and its Monitor at the times of
// devspaces.cacheUpdateSchedule (R-VM-005): a task of Task Scheduler, without administrator rights, with one trigger
// per time of the schedule, 5 minutes after that time. Task Scheduler itself decides when it runs: it never wakes the
// computer (no WakeToRun), runs on battery, has no time limit, and starts a time that the computer missed after the
// wake or the login (StartWhenAvailable). Its action is `wslg.exe`, a program without a console window (without it
// `wsl.exe`), with a script in the distribution (wslTaskScript): it starts the Monitor, gives it the schedule and the
// time zone, and then holds the distribution as the keeper does (KEEPER_SCRIPT) while a container runs there. Devspaces
// registers the task again when the setting changes (WslTask). No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner } from '../ports';
import { parseCacheSchedule, type CacheSchedule } from '../remoteMonitor/cacheSettings';
import { REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH, imageSettingsOf, type ImageSettings } from '../remoteMonitor/protocol';
import { envValue } from './dockerCli';
import { WSL_DISTRIBUTION } from './dockerHost';
import { KEEPER_SCRIPT } from './wslKeeper';

/** The start of the name of the task in the root folder of Task Scheduler; the SID of the Windows user follows. */
export const WSL_TASK_NAME_PREFIX = 'nimblescape Devspaces WSL';
/** The task starts this many minutes after a time of the schedule, so that the network is back after a wake or a login. */
export const WSL_TASK_DELAY_MINUTES = 5;
/** The log of the script of the task in the distribution: its last lines, kept at each run. */
export const WSL_TASK_LOG = '/var/log/devspaces-task.log';
/** The lines of WSL_TASK_LOG that each run keeps from earlier runs. */
export const WSL_TASK_LOG_LINES = 300;
/**
 * How often the script asks Docker again (`docker info`, 10 seconds apart) before it gives up: about 3 minutes, as a
 * window waits for Docker in the distribution, which systemd starts with it (about 45 seconds in a slow virtual machine).
 */
export const WSL_TASK_DOCKER_TRIES = 18;
/** The time limit of each call of `schtasks.exe` and `whoami.exe`. */
const TASK_CALL_TIMEOUT_MS = 30_000;
/** The start boundary of every trigger: a fixed date in the past, so that the definition is the same at each update. */
const START_DATE = '2026-01-01';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The name of the task of the Windows user with the SID `sid`: names in the root folder are shared by all users. */
export function wslTaskName(sid: string): string {
  return `${WSL_TASK_NAME_PREFIX} ${sid}`;
}

/** The SID in the output of `whoami /user /fo csv /nh` (`"computer\user","S-1-5-21-…"`), or undefined. */
export function parseWhoamiSid(output: string): string | undefined {
  return /"(S-1-\d+(?:-\d+)+)"/.exec(output)?.[1];
}

/** A time of the day of a trigger. */
export interface TriggerTime {
  hour: number;
  minute: number;
}

/**
 * The time of a trigger for the time `time` of a cron schedule: WSL_TASK_DELAY_MINUTES later on the same day. A time
 * whose delay would end on the next day (23:55 and later) stays as it is, because the next day may fall on another day
 * of the week or of the month.
 */
export function delayedTime(time: TriggerTime): TriggerTime {
  const minutes = time.hour * 60 + time.minute + WSL_TASK_DELAY_MINUTES;
  if (minutes >= 24 * 60) return time;
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

function boundary(time: TriggerTime): string {
  return `${START_DATE}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:00`;
}

function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** The months of a cron schedule as elements of Task Scheduler (`<Months><January />…</Months>`). */
function monthsXml(months: ReadonlySet<number>): string {
  return `<Months>${sorted(months)
    .map((month) => `<${MONTHS[month - 1]} />`)
    .join('')}</Months>`;
}

function weekdaysXml(weekdays: ReadonlySet<number>): string {
  return `<DaysOfWeek>${sorted(weekdays)
    .map((day) => `<${WEEKDAYS[day]} />`)
    .join('')}</DaysOfWeek>`;
}

function calendarTrigger(time: TriggerTime, schedule: string, repetition?: string): string {
  return `<CalendarTrigger>${repetition ?? ''}<StartBoundary>${boundary(time)}</StartBoundary><Enabled>true</Enabled>${schedule}</CalendarTrigger>`;
}

/**
 * The triggers of Task Scheduler for `schedule`, in the local time of the computer (the time zone of the schedule):
 * - an interval of N minutes: every day from 00:05 every N minutes (Repetition), so the task runs every N minutes;
 * - a cron schedule: one trigger per hour of the schedule at its minute (one value, because two times of a schedule
 *   are at least 60 minutes apart), WSL_TASK_DELAY_MINUTES later (delayedTime); each day, the days of the week
 *   (ScheduleByWeek, or ScheduleByMonthDayOfWeek with all weeks when the months are limited), the days of the month
 *   (ScheduleByMonth), or for both, as cron, a trigger for each, so that either one starts the task. At most 48
 *   triggers, the limit of Task Scheduler.
 */
export function wslTaskTriggers(schedule: CacheSchedule): string[] {
  const start: TriggerTime = { hour: 0, minute: WSL_TASK_DELAY_MINUTES };
  if (schedule.kind === 'interval') {
    if (schedule.minutes >= 24 * 60) return [calendarTrigger(start, '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>')];
    const repetition = `<Repetition><Interval>PT${schedule.minutes}M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`;
    return [calendarTrigger(start, '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>', repetition)];
  }
  const { cron } = schedule;
  const allMonths = cron.months.size === 12;
  const kinds: string[] = [];
  if (cron.anyDay && cron.anyWeekday) {
    kinds.push(allMonths ? '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>' : `<ScheduleByMonth><DaysOfMonth>${range(1, 31)}</DaysOfMonth>${monthsXml(cron.months)}</ScheduleByMonth>`);
  } else {
    if (!cron.anyDay) kinds.push(`<ScheduleByMonth><DaysOfMonth>${daysXml(cron.days)}</DaysOfMonth>${monthsXml(cron.months)}</ScheduleByMonth>`);
    if (!cron.anyWeekday) {
      kinds.push(
        allMonths
          ? `<ScheduleByWeek>${weekdaysXml(cron.weekdays)}<WeeksInterval>1</WeeksInterval></ScheduleByWeek>`
          : `<ScheduleByMonthDayOfWeek><Weeks><Week>1</Week><Week>2</Week><Week>3</Week><Week>4</Week><Week>Last</Week></Weeks>${weekdaysXml(cron.weekdays)}${monthsXml(cron.months)}</ScheduleByMonthDayOfWeek>`,
      );
    }
  }
  const [minute] = sorted(cron.minutes);
  return sorted(cron.hours).flatMap((hour) => kinds.map((kind) => calendarTrigger(delayedTime({ hour, minute }), kind)));
}

function daysXml(days: ReadonlySet<number>): string {
  return sorted(days)
    .map((day) => `<Day>${day}</Day>`)
    .join('');
}

function range(from: number, to: number): string {
  return daysXml(new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index)));
}

/** `text` with only letters, digits and `_ ./*,+:-` (any other character is `?`), for a word of the script. */
function scriptText(text: string): string {
  return text.replace(/[^\w ./*,+:-]/g, '?');
}

/**
 * The script of the task (`sh -c`), as root in the distribution, in one line without a double quote, a backslash and a
 * percent sign, so that neither the command line nor the environment variables of Task Scheduler can change it: it
 * keeps the last WSL_TASK_LOG_LINES lines of its log, waits for Docker (`docker info`, WSL_TASK_DOCKER_TRIES times; systemd
 * starts it with the distribution), starts the Monitor (`docker start`), gives it the settings (`monitor.js settings -`,
 * the JSON in base64, which has no quote), writes each step into its log, and then runs the script of the keeper, which
 * holds the distribution while a container runs there (the Monitor during its background run) and ends after two quiet
 * checks. `set -f`: no file names for the `*` of a schedule.
 */
export function wslTaskScript(settings: ImageSettings): string {
  const input = Buffer.from(JSON.stringify(imageSettingsOf(settings))).toString('base64');
  const log = WSL_TASK_LOG;
  return [
    'set -f',
    `[ -f ${log} ]&&tail -n ${WSL_TASK_LOG_LINES} ${log} >${log}.part&&mv -f ${log}.part ${log}`,
    `exec >>${log} 2>&1`,
    'say(){ echo $(date -u -Iseconds) $*; }',
    `say INFO The task starts the Monitor with the schedule '${scriptText(settings.schedule)}' '(${scriptText(settings.timeZone)})'.`,
    'i=0',
    'until timeout 30 docker info >/dev/null 2>&1',
    'do i=$((i+1))',
    `if [ $i -ge ${WSL_TASK_DOCKER_TRIES} ]`,
    'then break',
    'fi',
    'sleep 10',
    'done',
    `if [ $i -ge ${WSL_TASK_DOCKER_TRIES} ]`,
    'then say WARN Docker did not answer in the distribution, so the task did not start the Monitor.',
    `elif timeout 120 docker start ${REMOTE_MONITOR_CONTAINER} >/dev/null`,
    `then if echo ${input}|base64 -d|timeout 60 docker exec -i ${REMOTE_MONITOR_CONTAINER} node ${REMOTE_MONITOR_SCRIPT_PATH} settings -`,
    'then say INFO The Monitor runs. It does its background run when it is due, and ends when idle.',
    'else say WARN The Monitor runs, but it did not take the schedule and the time zone.',
    'fi',
    'else say WARN The Monitor could not be started. The next start of a devspace creates it again.',
    'fi',
    KEEPER_SCRIPT,
  ].join(';');
}

/** `text` for the content of an element of XML, with `&`, `<` and `>` escaped. */
function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Whether `program` is `wslg.exe` (not `wsl.exe`). */
function isWslg(program: string): boolean {
  return path.win32.basename(program).toLowerCase() === 'wslg.exe';
}

/**
 * The arguments of the program of the action that run `script` as root in the WSL distribution of Devspaces, as one
 * line of Task Scheduler, as the keeper starts (WslKeeper): for `wslg.exe` (no console window) `--shell-type none`, which
 * runs `sh` without a shell of the user, and for `wsl.exe` `--exec`; the script is one argument in double quotes
 * (CommandLineToArgvW).
 */
export function wslTaskArguments(program: string, script: string): string {
  const run = isWslg(program) ? '--shell-type none' : '--exec';
  return `-d ${WSL_DISTRIBUTION} -u root --cd / ${run} sh -c "${script}"`;
}

/**
 * The definition of the task for Task Scheduler (`schtasks /Create /XML`): the triggers of wslTaskTriggers, the Windows
 * user `sid` only while logged on (InteractiveToken) and without administrator rights (LeastPrivilege), no second
 * instance while one runs, on battery too, no time limit, a missed time after the wake or the login, never a wake of the
 * computer.
 */
export function wslTaskXml(options: { sid: string; program: string; settings: ImageSettings; triggers: readonly string[] }): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Author>nimblescape Devspaces</Author>',
    `    <Description>Starts the WSL distribution of Devspaces and its Monitor at the times of devspaces.cacheUpdateSchedule (${xmlText(options.settings.schedule)}). Devspaces writes this task.</Description>`,
    `    <URI>\\${xmlText(wslTaskName(options.sid))}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    ...options.triggers.map((trigger) => `    ${trigger}`),
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlText(options.sid)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    // In double quotes, as Task Scheduler writes a path with spaces (`C:\Program Files\WSL\wslg.exe`).
    `      <Command>"${xmlText(options.program)}"</Command>`,
    `      <Arguments>${xmlText(wslTaskArguments(options.program, wslTaskScript(options.settings)))}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** The bytes of the file of the definition: UTF-16 LE with its byte order mark, as Task Scheduler writes it. */
export function wslTaskFileBytes(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/** A program of the System32 folder of Windows (SystemRoot), not from PATH. */
export function system32Program(env: NodeJS.ProcessEnv, name: string): string {
  const systemRoot = envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', name);
}

export interface WslTaskDeps {
  runner: Pick<ProcessRunner, 'run'>;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** The folder of the file of the definition (`%LOCALAPPDATA%\nimblescape\devspaces\task`). */
  folder: string;
  /** The program of the action: `wslg.exe` when it exists, else `wsl.exe` (wslTaskArguments); undefined without WSL. */
  program: () => string | undefined;
}

/**
 * The scheduled task of the Windows user. `update` registers the definition (`schtasks /Create /F`) when it differs from
 * its record (the file of the last definition that Task Scheduler took), or when the task is gone; `remove` deletes the
 * task and its record, and does nothing without a record. The calls of this window run one after the other. Neither
 * rejects: a failure is logged, and the next update tries again.
 */
export class WslTask {
  private work: Promise<void> = Promise.resolve();
  private sid: string | undefined;

  constructor(private readonly deps: WslTaskDeps) {}

  /** The record of the task: the file of the definition that Task Scheduler took last on this computer. */
  get file(): string {
    return path.join(this.deps.folder, 'task.xml');
  }

  /** Brings the task to `settings`. Never rejects. */
  update(settings: ImageSettings): Promise<void> {
    return this.enqueue(() => this.write(settings), 'could not be written');
  }

  /** Deletes the task and its file. Never rejects. */
  remove(): Promise<void> {
    return this.enqueue(() => this.delete(), 'could not be removed');
  }

  private enqueue(task: () => Promise<void>, failure: string): Promise<void> {
    this.work = this.work.then(task).catch((error: unknown) => {
      this.deps.logger.warn(`The scheduled task of the WSL distribution of Devspaces ${failure}: ${errorMessage(error)}`);
    });
    return this.work;
  }

  private async write(settings: ImageSettings): Promise<void> {
    const schedule = parseCacheSchedule(settings.schedule);
    if (schedule === undefined) throw new Error(`the schedule "${settings.schedule}" is not valid`);
    const program = this.deps.program();
    if (program === undefined) throw new Error('WSL is not installed');
    const sid = await this.userSid();
    const bytes = wslTaskFileBytes(wslTaskXml({ sid, program, settings, triggers: wslTaskTriggers(schedule) }));
    const before = await fs.promises.readFile(this.file).catch(() => undefined);
    if (before !== undefined && before.equals(bytes) && (await this.exists(sid))) return;
    await fs.promises.mkdir(this.deps.folder, { recursive: true });
    // Registered from a file of its own, which becomes the record only when Task Scheduler took it: a failure leaves the
    // record of the task that is registered (the next update tries again), and another window never registers half a file.
    const part = `${this.file}.${process.pid}.part`;
    await fs.promises.writeFile(part, bytes);
    const created = await this.schtasks(['/Create', '/TN', wslTaskName(sid), '/XML', part, '/F']);
    if (created !== undefined) {
      await fs.promises.rm(part, { force: true });
      throw new Error(created);
    }
    await fs.promises.rename(part, this.file);
    this.deps.logger.info(`Devspaces wrote its scheduled task "${wslTaskName(sid)}" (Task Scheduler): it starts the WSL distribution of Devspaces at the times of devspaces.cacheUpdateSchedule.`);
  }

  private async delete(): Promise<void> {
    // Without its record, this computer registered no task (or the user removed the file by hand): no call of Windows.
    if (!fs.existsSync(this.file)) return;
    const sid = await this.userSid();
    if (await this.exists(sid)) {
      const deleted = await this.schtasks(['/Delete', '/TN', wslTaskName(sid), '/F']);
      if (deleted !== undefined) throw new Error(deleted);
    }
    await fs.promises.rm(this.file, { force: true });
    this.deps.logger.info('Devspaces removed its scheduled task, which started the WSL distribution of Devspaces at the times of devspaces.cacheUpdateSchedule.');
  }

  /** Whether the task of the user exists (`schtasks /Query`). */
  private async exists(sid: string): Promise<boolean> {
    return (await this.schtasks(['/Query', '/TN', wslTaskName(sid)])) === undefined;
  }

  /** The SID of the Windows user of this process (`whoami /user`), once per window. */
  private async userSid(): Promise<string> {
    if (this.sid !== undefined) return this.sid;
    const result = await this.deps.runner.run(system32Program(this.deps.env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: TASK_CALL_TIMEOUT_MS });
    const sid = result.exitCode === 0 ? parseWhoamiSid(result.stdout) : undefined;
    if (sid === undefined) throw new Error(`whoami /user did not name the SID of the user (${failureOf(result)})`);
    this.sid = sid;
    return sid;
  }

  /** Runs `schtasks.exe` with `args`: undefined when it ended well, else a description of the failure. */
  private async schtasks(args: string[]): Promise<string | undefined> {
    const result = await this.deps.runner.run(system32Program(this.deps.env, 'schtasks.exe'), args, { timeoutMs: TASK_CALL_TIMEOUT_MS });
    if (result.exitCode === 0 && !result.timedOut) return undefined;
    return `schtasks ${args[0]} ${failureOf(result)}`;
  }
}

function failureOf(result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }): string {
  if (result.timedOut) return `did not end within ${TASK_CALL_TIMEOUT_MS / 1000} seconds`;
  const output = (result.stderr || result.stdout).trim();
  return `ended with exit code ${result.exitCode}${output ? `: ${output.slice(-500)}` : ''}`;
}
