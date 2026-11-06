// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The program of the scheduled task of the user on macOS and Linux (src/core/vm/vmTask.ts, R-VM-005), bundled to
// dist/vmTask.js; Devspaces copies it into the folder of the task, and the task runs it with the Electron of VS Code as
// Node.js: `<electron> vmTask.js --ms-enable-electron-run-as-node <task.json>`. At each start it reads its settings and
// the time of its last start. When a time of the schedule passed since then (vmTaskDue), it waits 5 minutes, starts the
// Lima VM of Devspaces when it is stopped (`limactl start`, on Linux in a scope of its own: limaRunner), starts the
// Monitor container (`docker start devspaces-monitor`, which an earlier open created) and gives it the current schedule
// and time zone (`monitor.js settings -`). Then it ends; the Monitor does its background run and ends when idle, and
// the idle check in the VM powers the VM off. When a window uses the VM at that time, the VM and the Monitor run
// already, and the steps change nothing. It writes what it does into the log of the task. Only Node.js built-ins and
// small modules of src/core.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../core/errors';
import type { Logger, ProcessRunner } from '../core/ports';
import { NodeProcessRunner } from '../core/process';
import { REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH } from '../core/remoteMonitor/protocol';
import { LimaInstance, limaEnv, limaSshArgs, type LimaPaths } from '../core/vm/limaInstance';
import { RUN_AS_NODE_ARG, VM_TASK_WAIT_MS, parseVmTaskConfig, parseVmTaskStamp, vmTaskDue, vmTaskPaths, vmTaskStampText, type VmTaskConfig } from '../core/vm/vmTask';

/** The log of the task is cut to its second half when it grows beyond this many bytes. */
export const MAX_TASK_LOG_BYTES = 256 * 1024;
/** The time limit of each `ssh` to the VM. */
export const TASK_SSH_TIMEOUT_MS = 60_000;

export interface VmTaskRunDeps {
  runner: Pick<ProcessRunner, 'run'>;
  logger: Logger;
  /** The settings file of the task (task.json). */
  configFile: string;
  /** The stamp of the task (last-start.json, next to the settings file). */
  stampFile: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  platform: NodeJS.Platform;
  /** `ssh` of this computer. Default: `ssh` from PATH. */
  ssh?: string;
}

/**
 * One start of the task: 0 when it did nothing or did its steps, 1 when a step failed (logged). Never throws.
 */
export async function runVmTask(deps: VmTaskRunDeps): Promise<number> {
  const { logger } = deps;
  try {
    const config = parseVmTaskConfig(await fs.promises.readFile(deps.configFile, 'utf8'));
    if (config === undefined) {
      logger.warn(`The settings of the task in ${deps.configFile} are not complete; the task does nothing.`);
      return 1;
    }
    const lastStartAt = parseVmTaskStamp(await fs.promises.readFile(deps.stampFile, 'utf8').catch(() => ''));
    const now = deps.now();
    // Without a stamp (removed by hand), the task counts from now, as for a new task.
    if (lastStartAt === undefined) {
      await fs.promises.writeFile(deps.stampFile, vmTaskStampText(now));
      return 0;
    }
    if (!vmTaskDue(config, lastStartAt, now)) return 0;
    // The stamp first: a step that fails waits for the next time of the schedule, and does not run again every hour.
    await fs.promises.writeFile(deps.stampFile, vmTaskStampText(now));
    logger.info(`A time of the schedule "${config.schedule}" (${config.timeZone}) passed since the last start of the task. The task starts the VM of Devspaces in ${VM_TASK_WAIT_MS / 60_000} minutes.`);
    await deps.sleep(VM_TASK_WAIT_MS);
    return (await startVmAndMonitor(config, deps)) ? 0 : 1;
  } catch (error) {
    logger.warn(`The task failed: ${errorMessage(error)}`);
    return 1;
  }
}

/** Starts the VM when it is stopped, then the Monitor, and gives the Monitor the schedule and the time zone. */
async function startVmAndMonitor(config: VmTaskConfig, deps: VmTaskRunDeps): Promise<boolean> {
  const { logger, runner } = deps;
  const paths: LimaPaths = { root: path.dirname(config.limaHome), lima: path.dirname(path.dirname(path.dirname(config.limactl))), home: config.limaHome, download: '' };
  const instance = new LimaInstance({ limactl: config.limactl, paths, runner: limaRunner(runner, deps.platform, config.limactl) as ProcessRunner, logger, env: deps.env });
  const status = await instance.status();
  if (status === 'missing') {
    logger.warn('The VM of Devspaces does not exist; the task does nothing.');
    return false;
  }
  if (status !== 'running' && !(await instance.ensureRunning(undefined, (line) => logger.info(`limactl: ${line}`)))) return false;
  if (status === 'running') logger.info('The VM of Devspaces runs already.');
  const ssh = deps.ssh ?? 'ssh';
  const env = limaEnv(deps.env, paths);
  const start = await runner.run(ssh, limaSshArgs(paths, `docker start ${REMOTE_MONITOR_CONTAINER}`), { env, timeoutMs: TASK_SSH_TIMEOUT_MS });
  if (start.exitCode !== 0 || start.timedOut) {
    logger.warn(`The Monitor could not be started (${outputOf(start)}). The next start of a devspace creates it again.`);
    return false;
  }
  const settings = JSON.stringify({ schedule: config.schedule, timeZone: config.timeZone });
  const given = await runner.run(ssh, limaSshArgs(paths, `docker exec -i ${REMOTE_MONITOR_CONTAINER} node ${REMOTE_MONITOR_SCRIPT_PATH} settings -`), {
    env,
    input: settings,
    timeoutMs: TASK_SSH_TIMEOUT_MS,
  });
  if (given.exitCode !== 0 || given.timedOut) {
    logger.warn(`The Monitor runs, but it did not take the schedule and the time zone (${outputOf(given)}); it uses those of the last open.`);
    return false;
  }
  logger.info(`The Monitor runs with the schedule "${config.schedule}" (${config.timeZone}). It does its background run when it is due, and ends when idle.`);
  return true;
}

/** The arguments of `systemd-run` before the command that it runs in a scope of its own (limaRunner). */
export const OWN_SCOPE_ARGS: readonly string[] = ['--user', '--scope', '--quiet', '--collect', '--'];

/**
 * The runner of `limactl`: on Linux, `limactl start` runs in a scope of its own of the systemd of the user
 * (`systemd-run --user --scope`). When the program ends, systemd stops every process that the service of the task left
 * behind; the host agent of Lima and its QEMU are in the scope, so the VM goes on. On macOS, Lima starts its host agent in
 * a process group of its own, and the launch agent leaves its process group (AbandonProcessGroup).
 */
export function limaRunner(runner: Pick<ProcessRunner, 'run'>, platform: NodeJS.Platform, limactl: string): Pick<ProcessRunner, 'run'> {
  if (platform !== 'linux') return runner;
  return {
    run: (file, args, options) => {
      if (file === limactl && args[0] === 'start') return runner.run('systemd-run', [...OWN_SCOPE_ARGS, file, ...args], options);
      return runner.run(file, args, options);
    },
  };
}

function outputOf(result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }): string {
  if (result.timedOut) return 'no answer in time';
  const output = (result.stderr || result.stdout).trim();
  return output ? output.slice(-500) : `exit code ${result.exitCode}`;
}

/** A logger that appends lines with the time to `file`, and cuts the file to its second half when it is too large. */
export function fileLogger(file: string, now: () => number = Date.now): Logger {
  const write = (level: string, text: string): void => {
    try {
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_TASK_LOG_BYTES) {
        const kept = fs.readFileSync(file).subarray(size - Math.floor(MAX_TASK_LOG_BYTES / 2));
        const start = kept.indexOf(0x0a) + 1;
        fs.writeFileSync(file, kept.subarray(start));
      }
      fs.appendFileSync(file, `${new Date(now()).toISOString()} ${level} ${text}\n`);
    } catch {
      // The log is a help only; the task goes on without it.
    }
  };
  return {
    info: (text) => write('INFO', text),
    warn: (text) => write('WARN', text),
    error: (text, error) => write('ERROR', error === undefined ? text : `${text} ${errorMessage(error)}`),
    output: (text) => write('INFO', text),
  };
}

/** The settings file of the task in the arguments of the program (the argument of the run as Node.js is left out). */
export function configFileOf(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((arg) => arg !== RUN_AS_NODE_ARG);
}

/** Runs the task when this file is the main module. */
async function main(): Promise<void> {
  const configFile = configFileOf(process.argv);
  if (configFile === undefined) {
    process.stderr.write('Usage: vmTask.js <task.json>\n');
    process.exitCode = 2;
    return;
  }
  const paths = vmTaskPaths(path.dirname(path.dirname(configFile)));
  process.exitCode = await runVmTask({
    runner: new NodeProcessRunner(),
    logger: fileLogger(paths.log),
    configFile,
    stampFile: paths.stamp,
    env: process.env,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform: process.platform,
  });
}

if (require.main === module) void main();
