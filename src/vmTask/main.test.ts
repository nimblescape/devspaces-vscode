// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The program of the scheduled task (R-VM-005): it does nothing until a time of the schedule passed since its last
// start; then it waits 5 minutes, starts the VM when it is stopped, starts the Monitor and gives it the schedule and the
// time zone. `limactl` and `ssh` are fakes; the folder of the task is a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../core/ports';
import { REMOTE_MONITOR_SCRIPT_PATH } from '../core/remoteMonitor/protocol';
import { RUN_AS_NODE_ARG, VM_TASK_WAIT_MS, parseVmTaskStamp, vmTaskPaths, vmTaskStampText, type VmTaskConfig } from '../core/vm/vmTask';
import { MAX_TASK_LOG_BYTES, OWN_SCOPE_ARGS, configFileOf, fileLogger, runVmTask } from './main';

const T0 = Date.parse('2026-11-06T06:08:00Z');
const HOUR = 3_600_000;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-vm-task-run-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });
const listed = (status: 'Running' | 'Stopped') => ok(`${JSON.stringify({ name: 'devspaces', status, cpus: 4, memory: 4 * 2 ** 30 })}\n`);

function setUp(
  options: { lastStartAt?: number; status?: 'Running' | 'Stopped' | 'missing'; platform?: NodeJS.Platform; answers?: (file: string, args: readonly string[]) => RunResult | undefined } = {},
) {
  const paths = vmTaskPaths(root);
  fs.mkdirSync(paths.folder, { recursive: true });
  const config: VmTaskConfig = { schedule: '7 6 * * *', timeZone: 'UTC', limactl: path.join(root, 'lima', '2.2.1', 'bin', 'limactl'), limaHome: path.join(root, 'vm') };
  fs.writeFileSync(paths.config, JSON.stringify(config));
  if (options.lastStartAt !== undefined) fs.writeFileSync(paths.stamp, vmTaskStampText(options.lastStartAt));
  const calls: { file: string; args: readonly string[]; options?: RunOptions }[] = [];
  let status = options.status ?? 'Stopped';
  const runner = {
    run: async (file: string, args: readonly string[], runOptions?: RunOptions): Promise<RunResult> => {
      calls.push({ file, args, options: runOptions });
      const answer = options.answers?.(file, args);
      if (answer !== undefined) return answer;
      if (file === config.limactl && args[0] === 'list') return status === 'missing' ? ok('') : listed(status);
      // `limactl start` itself, or in a scope of its own of the systemd of the user (Linux).
      const start = file === 'systemd-run' ? args.slice(OWN_SCOPE_ARGS.length) : [file, ...args];
      if (start[0] === config.limactl && start[1] === 'start') {
        status = 'Running';
        return ok();
      }
      return ok();
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const sleep = vi.fn(async () => undefined);
  const platform = options.platform ?? 'linux';
  const run = () => runVmTask({ runner, logger, configFile: paths.config, stampFile: paths.stamp, env: { PATH: '/usr/bin' }, now: () => T0, sleep, platform, ssh: '/usr/bin/ssh' });
  return { paths, config, calls, logger, sleep, run, stamp: () => parseVmTaskStamp(fs.readFileSync(paths.stamp, 'utf8')) };
}

describe('the program of the scheduled task', () => {
  it('does nothing before a time of the schedule passed since its last start', async () => {
    const task = setUp({ lastStartAt: T0 - 60_000 });
    expect(await task.run()).toBe(0);
    expect(task.calls).toEqual([]);
    expect(task.sleep).not.toHaveBeenCalled();
    expect(task.logger.info).not.toHaveBeenCalled();
    expect(task.stamp()).toBe(T0 - 60_000);
  });

  it('without a stamp, counts from now and starts nothing', async () => {
    const task = setUp();
    expect(await task.run()).toBe(0);
    expect(task.calls).toEqual([]);
    expect(task.stamp()).toBe(T0);
  });

  it('after a time of the schedule: waits 5 minutes, starts the VM, starts the Monitor and gives it the schedule and the time zone', async () => {
    const task = setUp({ lastStartAt: T0 - 24 * HOUR });
    expect(await task.run()).toBe(0);
    expect(task.sleep).toHaveBeenCalledWith(VM_TASK_WAIT_MS);
    expect(VM_TASK_WAIT_MS).toBe(5 * 60_000);
    // The stamp before the steps, so that a failed step does not run again every hour.
    expect(task.stamp()).toBe(T0);
    expect(task.calls.map((call) => [call.file, call.args[0]])).toEqual([
      [task.config.limactl, 'list'],
      [task.config.limactl, 'list'],
      ['systemd-run', '--user'],
      ['/usr/bin/ssh', '-F'],
      ['/usr/bin/ssh', '-F'],
    ]);
    // On Linux, `limactl start` runs in a scope of its own, so that systemd does not stop the VM when the service of the
    // task ends. Mutation: a start without the scope fails it.
    expect(task.calls[2].args).toEqual(['--user', '--scope', '--quiet', '--collect', '--', task.config.limactl, 'start', '--tty=false', '--timeout=10m', 'devspaces']);
    // limactl and ssh with LIMA_HOME of Devspaces; ssh as root, without questions.
    for (const call of task.calls) expect(call.options?.env).toMatchObject({ LIMA_HOME: task.config.limaHome, PATH: '/usr/bin' });
    const [start, settings] = task.calls.slice(3);
    expect(start.args).toEqual(['-F', path.join(task.config.limaHome, 'devspaces', 'ssh.config'), '-o', 'BatchMode=yes', '-T', 'lima-devspaces', 'sudo -n docker start devspaces-monitor']);
    expect(settings.args.at(-1)).toBe(`sudo -n docker exec -i devspaces-monitor node ${REMOTE_MONITOR_SCRIPT_PATH} settings -`);
    expect(JSON.parse(String(settings.options?.input))).toEqual({ schedule: '7 6 * * *', timeZone: 'UTC' });
    expect(task.logger.warn).not.toHaveBeenCalled();
  });

  it('on macOS, starts the VM with `limactl start` itself (launchd leaves its process group)', async () => {
    const task = setUp({ lastStartAt: T0 - 24 * HOUR, platform: 'darwin' });
    expect(await task.run()).toBe(0);
    expect(task.calls.filter((call) => call.file === 'systemd-run')).toEqual([]);
    expect(task.calls.find((call) => call.args[0] === 'start')?.file).toBe(task.config.limactl);
  });

  it('leaves a running VM as it is (a window uses it)', async () => {
    const task = setUp({ lastStartAt: T0 - 24 * HOUR, status: 'Running' });
    expect(await task.run()).toBe(0);
    expect(task.calls.some((call) => call.args.includes('start'))).toBe(false);
    expect(task.logger.info).toHaveBeenCalledWith('The VM of Devspaces runs already.');
  });

  it('stops when the VM does not exist, or when the Monitor cannot be started, and logs it', async () => {
    const missing = setUp({ lastStartAt: T0 - 24 * HOUR, status: 'missing' });
    expect(await missing.run()).toBe(1);
    expect(missing.logger.warn).toHaveBeenCalledWith('The VM of Devspaces does not exist; the task does nothing.');
    expect(missing.calls.some((call) => call.file === '/usr/bin/ssh')).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-vm-task-run-'));
    const noMonitor = setUp({
      lastStartAt: T0 - 24 * HOUR,
      answers: (file, args) => (file === '/usr/bin/ssh' && String(args.at(-1)).includes('docker start') ? failed('Error response from daemon: No such container: devspaces-monitor') : undefined),
    });
    expect(await noMonitor.run()).toBe(1);
    expect(noMonitor.logger.warn).toHaveBeenCalledWith(
      'The Monitor could not be started (Error response from daemon: No such container: devspaces-monitor). The next start of a devspace creates it again.',
    );
    expect(noMonitor.calls.filter((call) => call.file === '/usr/bin/ssh')).toHaveLength(1);
  });

  it('logs settings that are not complete, and a failure of limactl', async () => {
    const task = setUp({ lastStartAt: T0 - 24 * HOUR });
    fs.writeFileSync(task.paths.config, '{"schedule":"7 6 * * *"}');
    expect(await task.run()).toBe(1);
    expect(task.logger.warn).toHaveBeenCalledWith(`The settings of the task in ${task.paths.config} are not complete; the task does nothing.`);
    const broken = setUp({ lastStartAt: T0 - 24 * HOUR, answers: (file, args) => (file === 'systemd-run' && args.includes('start') ? failed('qemu: no KVM') : undefined) });
    expect(await broken.run()).toBe(1);
    expect(broken.logger.warn).toHaveBeenCalledWith(expect.stringContaining('The Lima VM of Devspaces could not be started'));
  });

  it('reads the settings file from its arguments, without the argument of the run as Node.js', () => {
    expect(configFileOf(['/usr/share/code/code', '/t/vmTask.js', RUN_AS_NODE_ARG, '/t/task.json'])).toBe('/t/task.json');
    expect(configFileOf(['/usr/share/code/code', '/t/vmTask.js'])).toBeUndefined();
  });

  it('logs with the time, and keeps the second half of a log that grew too large', () => {
    const file = path.join(root, 'task.log');
    const log = fileLogger(file, () => T0);
    log.info('one');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${new Date(T0).toISOString()} INFO one\n`);
    fs.writeFileSync(file, `${'x'.repeat(99)}\n`.repeat(Math.ceil(MAX_TASK_LOG_BYTES / 100) + 10));
    log.warn('two');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.length).toBeLessThan(MAX_TASK_LOG_BYTES / 2 + 200);
    expect(text.startsWith('x')).toBe(true);
    expect(text.endsWith(`${new Date(T0).toISOString()} WARN two\n`)).toBe(true);
    // A folder that is gone: no error.
    expect(() => fileLogger(path.join(root, 'gone', 'task.log')).info('three')).not.toThrow();
  });
});
