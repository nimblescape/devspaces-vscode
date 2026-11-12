// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// HelperChannels.renew (docs/requirements.md R-DS-008): a worker that runs from an earlier build of its helper tag gets a
// worker from the current build in its place, opened beside it as work in the background (the helper image only checked,
// on a new connection of the relay, outside of any operation and any flow of the user); the earlier worker is closed
// once no operation runs on it. A failure keeps the earlier worker and waits before the next renew.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteDockerTarget, type DockerTarget } from '../docker/dockerHost';
import { operationDockerTarget, runWithDockerTarget } from '../docker/dockerTargets';
import { silentLogger, type Logger } from '../ports';
import { sshPromptsAllowed, withSshPrompts } from '../sshAskpass';
import type { HelperChannel } from './helperChannel';
import { CHANNEL_RENEW_RETRY_MS, CHANNEL_SWEEP_INTERVAL_MS, HelperChannels, type ChannelOpenOptions } from './helperChannels';

const REMOTE: DockerTarget = remoteDockerTarget('build-box');

/** A channel stand-in with the parts that HelperChannels uses. */
function fakeChannel(name: string) {
  const closeListeners: ((reason: string) => void)[] = [];
  const channel = {
    name,
    isOpen: true,
    busy: 0,
    lastUsed: Date.now(),
    closed: 0,
    onClose: (listener: (reason: string) => void) => {
      closeListeners.push(listener);
      return () => {};
    },
    close: () => {
      if (!channel.isOpen) return;
      channel.isOpen = false;
      channel.closed++;
      for (const listener of closeListeners) listener('closed');
    },
    closeNow: () => channel.close(),
    lose: () => {
      channel.isOpen = false;
      for (const listener of closeListeners) listener('lost');
    },
    flow: vi.fn(async (): Promise<unknown> => ({ from: name })),
  };
  return channel;
}
type FakeChannel = ReturnType<typeof fakeChannel>;

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (text) => lines.push(text), warn: (text) => lines.push(text) };
  return { logger, lines };
}

/** HelperChannels whose opens give `channels` in order, and record their options; the helper image check is recorded. */
function setup(...channels: FakeChannel[]) {
  const opens: (ChannelOpenOptions | undefined)[] = [];
  const checks: DockerTarget[] = [];
  const queue = [...channels];
  const open = vi.fn(async (_target: DockerTarget, options?: ChannelOpenOptions) => {
    opens.push(options);
    const next = queue.shift();
    if (next === undefined) throw new Error('no worker from the current build');
    return next as unknown as HelperChannel;
  });
  const checkPresent = vi.fn(async (target: DockerTarget) => {
    checks.push(target);
  });
  const { logger, lines } = recordingLogger();
  const helperChannels = new HelperChannels({ open, checkPresent, logger });
  return { helperChannels, open, opens, checks, checkPresent, lines };
}

describe('HelperChannels.renew', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a worker from the current build on a new connection, sends the calls there, and closes the earlier one at once when it is idle', async () => {
    const earlier = fakeChannel('earlier');
    const current = fakeChannel('current');
    const { helperChannels, opens, checks, lines } = setup(earlier, current);
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'earlier' });
    await helperChannels.renew(REMOTE);
    // The helper image is only checked (never built), and the worker never starts on the open connection of the relay.
    expect(checks).toEqual([REMOTE]);
    expect(opens).toEqual([undefined, { newConnection: true }]);
    expect(earlier.closed).toBe(1);
    expect(current.isOpen).toBe(true);
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'current' });
    expect(lines).toContain('The worker on build-box runs from the current build of the helper image now; the worker from the earlier build is closed once no operation runs on it.');
    helperChannels.dispose();
  });

  it('keeps an earlier worker on which an operation runs until it ended (the sweep), while the new calls go to the new worker', async () => {
    const earlier = fakeChannel('earlier');
    const current = fakeChannel('current');
    const { helperChannels } = setup(earlier, current);
    await helperChannels.get(REMOTE);
    earlier.busy = 1;
    await helperChannels.renew(REMOTE);
    expect(earlier.closed).toBe(0);
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'current' });
    await vi.advanceTimersByTimeAsync(CHANNEL_SWEEP_INTERVAL_MS);
    expect(earlier.closed).toBe(0);
    earlier.busy = 0;
    await vi.advanceTimersByTimeAsync(CHANNEL_SWEEP_INTERVAL_MS);
    expect(earlier.closed).toBe(1);
    // The new worker is not closed by that sweep.
    expect(current.closed).toBe(0);
    helperChannels.dispose();
  });

  it('keeps the earlier worker when the new one cannot be opened, and renews again only after CHANNEL_RENEW_RETRY_MS', async () => {
    const earlier = fakeChannel('earlier');
    const current = fakeChannel('current');
    const { helperChannels, open, lines } = setup(earlier);
    await helperChannels.get(REMOTE);
    await helperChannels.renew(REMOTE);
    expect(earlier.closed).toBe(0);
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'earlier' });
    expect(lines).toContain(
      'The worker on build-box stays on the earlier build of the helper image, because a worker from the current build could not be opened (tried again in 60 minutes): no worker from the current build',
    );
    // Each heartbeat asks again; within the wait nothing is opened.
    open.mockResolvedValue(current as unknown as HelperChannel);
    await helperChannels.renew(REMOTE);
    expect(open).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + CHANNEL_RENEW_RETRY_MS);
    await helperChannels.renew(REMOTE);
    expect(open).toHaveBeenCalledTimes(3);
    expect(earlier.closed).toBe(1);
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'current' });
    helperChannels.dispose();
  });

  it('opens nothing when the helper image is not present (or Devspaces was removed from the engine), and keeps the earlier worker', async () => {
    const earlier = fakeChannel('earlier');
    const { helperChannels, open, checkPresent } = setup(earlier, fakeChannel('current'));
    await helperChannels.get(REMOTE);
    checkPresent.mockRejectedValueOnce(new Error('the helper image is missing'));
    await helperChannels.renew(REMOTE);
    expect(open).toHaveBeenCalledTimes(1);
    expect(earlier.closed).toBe(0);
    helperChannels.dispose();
  });

  it('does nothing without an open worker, and runs one renew at a time', async () => {
    const earlier = fakeChannel('earlier');
    const { helperChannels, open, checkPresent } = setup(earlier, fakeChannel('current'));
    await helperChannels.renew(REMOTE);
    expect(open).not.toHaveBeenCalled();
    await helperChannels.get(REMOTE);
    let finishCheck!: () => void;
    checkPresent.mockImplementationOnce(() => new Promise<void>((resolve) => (finishCheck = resolve)));
    const first = helperChannels.renew(REMOTE);
    const second = helperChannels.renew(REMOTE);
    await vi.advanceTimersByTimeAsync(0);
    finishCheck();
    await Promise.all([first, second]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(earlier.closed).toBe(1);
    helperChannels.dispose();
  });

  it('runs outside of the operation and the flow of the user that asked for it, so that its login asks nothing', async () => {
    const seen: { target: unknown; prompts: boolean }[] = [];
    const earlier = fakeChannel('earlier');
    const current = fakeChannel('current');
    const queue = [earlier, current];
    const helperChannels = new HelperChannels({
      open: async () => {
        seen.push({ target: operationDockerTarget(), prompts: sshPromptsAllowed() });
        return queue.shift() as unknown as HelperChannel;
      },
      logger: silentLogger,
    });
    await helperChannels.get(REMOTE);
    await withSshPrompts(() => runWithDockerTarget(REMOTE, () => helperChannels.renew(REMOTE)));
    expect(seen).toEqual([
      { target: undefined, prompts: false },
      { target: undefined, prompts: false },
    ]);
    helperChannels.dispose();
  });

  it('close of the engine closes the worker of a renew that runs, and a retired worker on which an operation runs', async () => {
    const earlier = fakeChannel('earlier');
    const current = fakeChannel('current');
    const { helperChannels, checkPresent } = setup(earlier, current);
    await helperChannels.get(REMOTE);
    let finishCheck!: () => void;
    checkPresent.mockImplementationOnce(() => new Promise<void>((resolve) => (finishCheck = resolve)));
    const renewing = helperChannels.renew(REMOTE);
    await vi.advanceTimersByTimeAsync(0);
    helperChannels.close(REMOTE);
    finishCheck();
    await renewing;
    expect(earlier.closed).toBe(1);
    expect(current.closed).toBe(1);

    const busy = fakeChannel('busy');
    const next = fakeChannel('next');
    const second = setup(busy, next);
    await second.helperChannels.get(REMOTE);
    busy.busy = 1;
    await second.helperChannels.renew(REMOTE);
    expect(busy.closed).toBe(0);
    second.helperChannels.close(REMOTE);
    expect(busy.closed).toBe(1);
    expect(next.closed).toBe(1);
    second.helperChannels.dispose();
    helperChannels.dispose();
  });

  it('dispose closes a retired worker; a renew after dispose opens nothing', async () => {
    const earlier = fakeChannel('earlier');
    const current = fakeChannel('current');
    const { helperChannels, open } = setup(earlier, current);
    await helperChannels.get(REMOTE);
    earlier.busy = 1;
    await helperChannels.renew(REMOTE);
    helperChannels.dispose();
    expect(earlier.closed).toBe(1);
    expect(current.closed).toBe(1);
    await helperChannels.renew(REMOTE);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('closes the new worker when the earlier one was lost meanwhile and a call opened another one', async () => {
    const earlier = fakeChannel('earlier');
    const reopened = fakeChannel('reopened');
    const current = fakeChannel('current');
    const queue: FakeChannel[] = [earlier];
    let finishRenew!: (channel: HelperChannel) => void;
    const open = vi.fn(async (_target: DockerTarget, options?: ChannelOpenOptions) => {
      if (options?.newConnection === true) return new Promise<HelperChannel>((resolve) => (finishRenew = resolve));
      return (queue.shift() ?? reopened) as unknown as HelperChannel;
    });
    const helperChannels = new HelperChannels({ open, logger: silentLogger });
    await helperChannels.get(REMOTE);
    const renewing = helperChannels.renew(REMOTE);
    await vi.advanceTimersByTimeAsync(0);
    earlier.lose();
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'reopened' });
    finishRenew(current as unknown as HelperChannel);
    await renewing;
    expect(current.closed).toBe(1);
    expect(await helperChannels.flow(REMOTE, 'op', {})).toEqual({ from: 'reopened' });
    helperChannels.dispose();
  });
});
