// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// monitorImage: the current build of the helper tag, a failed tag is a warning, and the tag has the time limit of the
// monitor's Docker calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_MONITOR_DOCKER_TIMEOUT_MS } from '../core/remoteMonitor/remoteSessionMonitor';
import type { Logger } from '../core/ports';
import type { DockerEngine } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { monitorImage } from './flowOperations';

const OWN = { tag: 'devspaces-worker:0123456789ab', id: `sha256:${'a'.repeat(64)}` };

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    output: () => {},
  };
  return { logger, lines };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('monitorImage', () => {
  it('the current build of the helper tag (R-DS-009), tagged as the monitor tag; the own image when the tag is on none or cannot be read', async () => {
    const current = `sha256:${'b'.repeat(64)}`;
    const tags: string[] = [];
    const tagImage = async (image: string, reference: string) => void tags.push(`${image} ${reference}`);
    const { logger, lines } = recordingLogger();
    const rebuilt: DockerEngine = { ...unusedEngine(), inspect: async (kind, reference) => (kind === 'image' && reference === OWN.tag ? { Id: current } : undefined), tagImage };
    expect(await monitorImage(rebuilt, OWN, logger, new AbortController().signal)).toEqual({ reference: 'devspaces-monitor:0123456789ab', id: current });
    for (const inspect of [async () => undefined, async () => ({ Id: 'sha256:x' }), async () => Promise.reject(new Error('socket gone'))]) {
      const engine: DockerEngine = { ...unusedEngine(), inspect, tagImage };
      expect(await monitorImage(engine, OWN, logger, new AbortController().signal)).toEqual({ reference: 'devspaces-monitor:0123456789ab', id: OWN.id });
    }
    expect(tags).toEqual([`${current} devspaces-monitor:0123456789ab`, ...Array.from({ length: 3 }, () => `${OWN.id} devspaces-monitor:0123456789ab`)]);
    expect(lines).toEqual([]);
    // A cancel of the inspect passes.
    const cancel = new AbortController();
    cancel.abort();
    const engine: DockerEngine = { ...unusedEngine(), inspect: async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), tagImage };
    await expect(monitorImage(engine, OWN, logger, cancel.signal)).rejects.toThrow();
  });

  it('a failed tag is logged as a warning, and the monitor runs from the ID', async () => {
    const { logger, lines } = recordingLogger();
    const engine: DockerEngine = { ...unusedEngine(), tagImage: async () => Promise.reject(new Error('no such image')) };
    expect(await monitorImage(engine, OWN, logger, new AbortController().signal)).toEqual({ reference: OWN.id });
    expect(lines).toEqual([`warn The image of the Monitor could not be tagged as devspaces-monitor:0123456789ab; it runs from ${OWN.id}: no such image`]);
  });

  it('a tag without an answer ends at REMOTE_MONITOR_DOCKER_TIMEOUT_MS; the monitor runs from the ID', async () => {
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => limit.signal);
    const { logger, lines } = recordingLogger();
    const engine: DockerEngine = {
      ...unusedEngine(),
      tagImage: (_image, _reference, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          setTimeout(() => reject(new Error('not limited')), 500);
        }),
    };
    const running = monitorImage(engine, OWN, logger, new AbortController().signal);
    setTimeout(() => limit.abort(), 20);
    expect(await running).toEqual({ reference: OWN.id });
    expect(timeout).toHaveBeenCalledWith(REMOTE_MONITOR_DOCKER_TIMEOUT_MS);
    expect(lines).toEqual([expect.stringContaining('no answer in time')]);
  });
});
