// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The cleanup of the engine by the Monitor (engineCleanup.ts, docs/requirements.md R-DS-007) on a fake engine: what it
// removes, what it keeps, its record in the volume, and that it never throws.
import { describe, expect, it } from 'vitest';
import { SWEEP_FILTERS } from '../core/helperChannel/protocol';
import { LABEL_HELPER } from '../core/names';
import { RunReportBuilder } from '../core/remoteMonitor/runReport';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { EngineFilters, EngineImage } from '../core/worker/dockerEngine';
import { BUILD_CACHE_UNUSED_FILTER, HELPER_TAG_UNUSED_MS, parseCleanupState } from './cleanupRules';
import { EngineCleanup, type EngineCleanupDeps } from './engineCleanup';
import type { ReferencesInUse } from './images';
import { withRunNotes } from './runNotes';

const OWN = 'devspaces-worker:aaaaaaaaaaaa';
const OWN_MONITOR = 'devspaces-monitor:aaaaaaaaaaaa';
const OLD = 'devspaces-worker:bbbbbbbbbbbb';
const OLD_MONITOR = 'devspaces-monitor:bbbbbbbbbbbb';
const BASE = 'node:26-trixie-slim';
const PIN = { version: '0.30.0', image: 'docker/buildx-bin', digest: `sha256:${'f'.repeat(64)}` };
const id = (c: string): string => `sha256:${c.repeat(64)}`;
const START = Date.parse('2026-11-12T08:00:00.000Z');
const DAY = 24 * 60 * 60_000;

interface FakeImage {
  tags: string[];
  layers: string[];
  helper?: boolean;
}

/**
 * The engine of the test: its images by ID, the images that containers use (`running`, and `stopped`: Docker refuses
 * the removal of their last reference), and the calls that change something.
 */
class FakeEngine {
  readonly images = new Map<string, FakeImage>();
  readonly running = new Set<string>();
  readonly stopped = new Set<string>();
  readonly removals: string[] = [];
  readonly prunes: Array<{ what: string; filters: EngineFilters }> = [];
  /** Methods that fail with an error of the engine. */
  readonly failing = new Set<string>();

  add(imageId: string, image: FakeImage): void {
    this.images.set(imageId, image);
  }

  tags(): string[] {
    return [...this.images.values()].flatMap((image) => image.tags).sort();
  }

  private resolve(reference: string): string | undefined {
    if (this.images.has(reference)) return reference;
    return [...this.images].find(([, image]) => image.tags.includes(reference))?.[0];
  }

  private check(method: string): void {
    if (this.failing.has(method)) throw new Error(`${method} failed`);
  }

  port(): EngineCleanupDeps['engine'] {
    return {
      ...unusedEngine(),
      images: async (filters: EngineFilters): Promise<EngineImage[]> => {
        this.check('images');
        const listed: EngineImage[] = [];
        for (const [imageId, image] of this.images) {
          const labels: Record<string, string> = image.helper === true ? { [LABEL_HELPER]: 'true' } : {};
          if (filters.label !== undefined && !filters.label.every((label) => label === `${LABEL_HELPER}=true` && image.helper === true)) continue;
          if (filters.reference !== undefined && !image.tags.some((tag) => filters.reference!.includes(tag.slice(0, tag.lastIndexOf(':'))))) continue;
          listed.push({ id: imageId, repoTags: [...image.tags], repoDigests: [], labels, created: '2026-11-01T00:00:00Z' });
        }
        return listed;
      },
      inspect: async (kind, reference) => {
        this.check('inspect');
        expect(kind).toBe('image');
        const imageId = this.resolve(reference);
        return imageId === undefined ? undefined : { Id: imageId, RootFS: { Type: 'layers', Layers: this.images.get(imageId)!.layers } };
      },
      containerIds: async (filters) => {
        this.check('containerIds');
        expect(filters.status).toEqual(['running']);
        return (filters.ancestor ?? []).filter((imageId) => this.running.has(imageId)).map((imageId) => `container-of-${imageId}`);
      },
      removeImage: async (reference) => {
        this.check('removeImage');
        const imageId = this.resolve(reference);
        if (imageId === undefined) return 'missing';
        const image = this.images.get(imageId)!;
        const byTag = imageId !== reference;
        if (byTag && image.tags.length > 1) {
          image.tags = image.tags.filter((tag) => tag !== reference);
          this.removals.push(reference);
          return 'removed';
        }
        if (this.running.has(imageId) || this.stopped.has(imageId)) return 'inUse';
        this.images.delete(imageId);
        this.removals.push(reference);
        return 'removed';
      },
      pruneContainers: async (filters) => {
        this.check('pruneContainers');
        this.prunes.push({ what: 'containers', filters });
        return ['c'.repeat(64)];
      },
      pruneBuildCache: async (filters) => {
        this.check('pruneBuildCache');
        this.prunes.push({ what: 'build cache', filters });
        return { records: 3, bytes: 5_000_000 };
      },
    };
  }
}

function setup(options: { own?: { tag: string; baseImage: string | undefined } | null; references?: ReferencesInUse; vm?: boolean } = {}) {
  const engine = new FakeEngine();
  const log: string[] = [];
  let now = START;
  let record: string | undefined;
  let failWrite = false;
  const cleanup = new EngineCleanup({
    engine: engine.port(),
    log: (message) => log.push(message),
    now: () => now,
    record: {
      read: async () => record,
      write: async (text) => {
        if (failWrite) throw new Error('the volume is full');
        record = text;
      },
    },
    ownHelper: async () => (options.own === null ? undefined : (options.own ?? { tag: OWN, baseImage: BASE })),
    referencesInUse: async () => options.references ?? { references: [], complete: true },
    vm: options.vm ?? false,
    buildx: PIN,
  });
  return {
    engine,
    log,
    cleanup,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    state: () => parseCleanupState(record),
    setRecord: (text: string) => {
      record = text;
    },
    failWrite: () => {
      failWrite = true;
    },
  };
}

/**
 * The images of a typical engine: debian under node 26 (the current base, BASE) under the own helper image (with its
 * monitor tag); node 24 (an older base) under the earlier build of the helper image and under the helper image OLD of an
 * older version (with its monitor tag); the build images of the pin, an older and a newer version.
 */
function typicalEngine(engine: FakeEngine): void {
  engine.add(id('d'), { tags: ['debian:trixie-slim'], layers: ['debian'] });
  engine.add(id('6'), { tags: [BASE], layers: ['debian', 'node26'] });
  engine.add(id('4'), { tags: [], layers: ['debian', 'node24'] });
  engine.add(id('1'), { tags: [OWN, OWN_MONITOR], layers: ['debian', 'node26', 'own'], helper: true });
  engine.add(id('e'), { tags: [], layers: ['debian', 'node24', 'own'], helper: true });
  engine.add(id('b'), { tags: [OLD, OLD_MONITOR], layers: ['debian', 'node24', 'old'], helper: true });
  engine.add(id('x'), { tags: ['devspaces-buildx:0.30.0'], layers: ['buildx30'] });
  engine.add(id('y'), { tags: ['devspaces-buildx:0.29.1'], layers: ['buildx29'] });
  engine.add(id('z'), { tags: ['devspaces-buildx:0.31.0'], layers: ['buildx31'] });
}

describe('EngineCleanup', () => {
  it('a first pass removes the stopped helper containers, the earlier builds and the older build images, and records the rest', async () => {
    const t = setup();
    typicalEngine(t.engine);
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => t.cleanup.pass());
    expect(t.engine.prunes).toEqual([{ what: 'containers', filters: SWEEP_FILTERS }]);
    // The report of the run (R-DS-003): each object that the cleanup removed.
    expect(notes.finish(0, true).events).toEqual({
      engineObjectRemoved: {
        count: 3,
        items: ['1 stopped helper container', 'the earlier build eeeeeeeeeeee of the workspace helper image', 'the build image devspaces-buildx:0.29.1 of an older version'],
      },
    });
    // The earlier build, and the build image of the older version. The helper tag OLD is new to the record: its grace
    // period starts; node 24 is still the base of OLD.
    expect(t.engine.removals).toEqual([id('e'), 'devspaces-buildx:0.29.1']);
    expect(t.state().helperTags).toEqual({ [OWN]: START, [OLD]: START });
    expect(t.state().helperBases).toEqual({ [id('6')]: START, [id('4')]: START });
    expect(t.log).toContain('Removed 1 stopped helper container.');
    expect(t.log).toContain(`Removed the earlier build eeeeeeeeeeee of the workspace helper image.`);
    expect(t.log).toContain('Removed the build image devspaces-buildx:0.29.1 of an older version.');
  });

  it('after 7 days without a running container, removes a helper tag with its monitor tag, then its image and its older base image', async () => {
    const t = setup();
    typicalEngine(t.engine);
    await t.cleanup.pass();
    // A worker of the own tag runs: the own tag is used, OLD is not.
    t.engine.running.add(id('1'));
    t.advance(HELPER_TAG_UNUSED_MS - 1);
    await t.cleanup.observe();
    await t.cleanup.pass();
    expect(t.engine.tags()).toContain(OLD);
    t.advance(1);
    await t.cleanup.pass();
    // The monitor tag first, then the helper tag (the last one: the image goes), then node 24, on which no image is
    // built anymore.
    expect(t.engine.removals.slice(2)).toEqual([OLD_MONITOR, OLD, id('4')]);
    expect(t.engine.tags()).toEqual([OWN_MONITOR, OWN, 'debian:trixie-slim', 'devspaces-buildx:0.30.0', 'devspaces-buildx:0.31.0', BASE].sort());
    expect(t.state().helperTags).toEqual({ [OWN]: t.now() });
    expect(t.state().helperBases).toEqual({ [id('6')]: t.now() });
    expect(t.log).toContain(`Removed the workspace helper image ${OLD}, which no running container used for 7 days.`);
    expect(t.log).toContain(`Removed the image ${id('4').slice(7, 19)}, an older base image of the workspace helper image.`);
  });

  it('never removes the own helper tag, also when no container used it for 7 days', async () => {
    const t = setup();
    typicalEngine(t.engine);
    await t.cleanup.pass();
    t.advance(HELPER_TAG_UNUSED_MS * 2);
    await t.cleanup.pass();
    expect(t.engine.tags()).toContain(OWN);
    expect(t.engine.tags()).toContain(OWN_MONITOR);
    expect(t.engine.tags()).not.toContain(OLD);
  });

  it('a helper tag that a running container used within 7 days stays', async () => {
    const t = setup();
    typicalEngine(t.engine);
    await t.cleanup.pass();
    t.advance(6 * DAY);
    t.engine.running.add(id('b'));
    await t.cleanup.observe();
    t.engine.running.delete(id('b'));
    t.advance(6 * DAY);
    await t.cleanup.pass();
    expect(t.engine.tags()).toContain(OLD);
    expect(t.state().helperTags[OLD]).toBe(START + 6 * DAY);
  });

  it('keeps the image of a helper tag that a stopped container uses, and names it in the log', async () => {
    const t = setup();
    typicalEngine(t.engine);
    t.engine.stopped.add(id('b'));
    t.engine.stopped.add(id('e'));
    await t.cleanup.pass();
    t.advance(HELPER_TAG_UNUSED_MS);
    await t.cleanup.pass();
    // The monitor tag goes (the image keeps its helper tag); Docker refuses the last tag.
    expect(t.engine.tags()).toContain(OLD);
    expect(t.engine.tags()).not.toContain(OLD_MONITOR);
    expect(t.engine.images.has(id('e'))).toBe(true);
    // The tag stays in the record, so that the next pass tries again.
    expect(t.state().helperTags[OLD]).toBe(START);
    expect(t.log.at(-1)).toBe(
      `A container uses these, so they stay: the workspace helper image ${OLD}, which no running container used for 7 days; the earlier build eeeeeeeeeeee of the workspace helper image.`,
    );
    // node 24 stays: images are built on it.
    expect(t.engine.images.has(id('4'))).toBe(true);
  });

  it('removes a monitor tag whose helper tag a rebuild moved to another image', async () => {
    const t = setup();
    typicalEngine(t.engine);
    // The Monitor ran from the image b; a rebuild moved its helper tag to the image n.
    t.engine.images.get(id('b'))!.tags = [OLD_MONITOR];
    t.engine.add(id('n'), { tags: [OLD], layers: ['debian', 'node26', 'old'], helper: true });
    await t.cleanup.pass();
    // It was the last tag of its image: the image goes with it.
    expect(t.engine.removals).toContain(OLD_MONITOR);
    expect(t.engine.images.has(id('b'))).toBe(false);
    expect(t.engine.tags()).toContain(OLD);
  });

  it('keeps an older base image that has a second tag, that a computer uses, or that is the base of the own Dockerfile', async () => {
    const t = setup({ references: { references: ['node:22'], complete: true }, own: { tag: OWN, baseImage: 'node:24' } });
    t.engine.add(id('1'), { tags: [OWN], layers: ['debian', 'node26', 'own'], helper: true });
    t.engine.add(id('6'), { tags: [BASE], layers: ['debian', 'node26'] });
    t.engine.add(id('4'), { tags: ['node:24'], layers: ['debian', 'node24'] });
    t.engine.add(id('2'), { tags: ['node:22'], layers: ['debian', 'node22'] });
    t.engine.add(id('9'), { tags: ['node:20', 'my-node:latest'], layers: ['debian', 'node20'] });
    // Each of them was the base of a helper image once.
    t.setRecord(JSON.stringify({ helperTags: {}, helperBases: { [id('4')]: START, [id('2')]: START, [id('9')]: START } }));
    await t.cleanup.pass();
    expect(t.engine.removals).toEqual([]);
    expect(Object.keys(t.state().helperBases).sort()).toEqual([id('2'), id('4'), id('6'), id('9')].sort());
  });

  it('removes nothing of the helper tags and the base images when its own helper tag is not known', async () => {
    const t = setup({ own: null });
    typicalEngine(t.engine);
    t.setRecord(JSON.stringify({ helperTags: { [OLD]: START - 8 * DAY }, helperBases: { [id('4')]: START - DAY } }));
    t.engine.images.get(id('b'))!.tags = [OLD_MONITOR];
    t.engine.add(id('n'), { tags: [OLD], layers: ['debian', 'node26', 'old'], helper: true });
    await t.cleanup.pass();
    // A stale monitor tag, the earlier builds and an older build image still go.
    expect(t.engine.removals).toEqual([OLD_MONITOR, id('e'), 'devspaces-buildx:0.29.1']);
    expect(t.engine.tags()).toContain(OLD);
    expect(t.engine.images.has(id('4'))).toBe(true);
  });

  it('removes no base image when the image references in use are not complete', async () => {
    const t = setup({ references: { references: [], complete: false } });
    t.engine.add(id('1'), { tags: [OWN], layers: ['debian', 'node26', 'own'], helper: true });
    t.engine.add(id('6'), { tags: [BASE], layers: ['debian', 'node26'] });
    t.engine.add(id('4'), { tags: ['node:24'], layers: ['debian', 'node24'] });
    t.setRecord(JSON.stringify({ helperTags: {}, helperBases: { [id('4')]: START } }));
    await t.cleanup.pass();
    expect(t.engine.removals).toEqual([]);
    expect(t.log).toContain('The image references in use could not all be read, so no older base image of the helper image is removed.');
  });

  it('removes an older base image without a tag by its ID, and forgets a recorded base image that is gone', async () => {
    const t = setup();
    t.engine.add(id('1'), { tags: [OWN], layers: ['debian', 'node26', 'own'], helper: true });
    t.engine.add(id('6'), { tags: [BASE], layers: ['debian', 'node26'] });
    // A pull of node:26 took the tag from the older image.
    t.engine.add(id('7'), { tags: [], layers: ['debian', 'node26old'] });
    t.setRecord(JSON.stringify({ helperTags: {}, helperBases: { [id('7')]: START - DAY, [id('5')]: START - DAY } }));
    await t.cleanup.pass();
    expect(t.engine.removals).toEqual([id('7')]);
    expect(t.state().helperBases).toEqual({ [id('6')]: START });
  });

  it('prunes the build cache that no build used for 7 days only on the VM of Devspaces', async () => {
    const t = setup({ vm: true });
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => t.cleanup.pass());
    expect(notes.finish(0, true).events.engineObjectRemoved?.items).toContain('3 records of the build cache (5 MB)');
    expect(t.engine.prunes).toEqual([
      { what: 'containers', filters: SWEEP_FILTERS },
      { what: 'build cache', filters: { until: [BUILD_CACHE_UNUSED_FILTER] } },
    ]);
    expect(t.log).toContain('Removed 3 records of the build cache that no build used for 7 days (Docker counts 5 MB).');
    const other = setup({ vm: false });
    await other.cleanup.pass();
    expect(other.engine.prunes.map((prune) => prune.what)).toEqual(['containers']);
  });

  it('never throws: each failure of the engine is one line of the log, and the other parts still run', async () => {
    const t = setup({ vm: true });
    typicalEngine(t.engine);
    for (const method of ['pruneContainers', 'images', 'pruneBuildCache']) t.engine.failing.add(method);
    await expect(t.cleanup.pass()).resolves.toBeUndefined();
    expect(t.engine.removals).toEqual([]);
    expect(t.log).toEqual([
      'The stopped helper containers could not be removed: pruneContainers failed',
      'The workspace helper images could not be listed, so none is removed: images failed',
      'The build images could not be listed, so none is removed: images failed',
      'The build cache could not be pruned: pruneBuildCache failed',
    ]);
    await expect(t.cleanup.observe()).resolves.toBeUndefined();
  });

  // The cleanup catches a failure of its own (not of the engine) itself; the report of the run still names it.
  it('a failure of the cleanup itself is one line, and a failure in the report of the run', async () => {
    const engine = new FakeEngine();
    typicalEngine(engine);
    const log: string[] = [];
    const cleanup = new EngineCleanup({
      engine: engine.port(),
      log: (message) => log.push(message),
      now: () => {
        throw new Error('the clock broke');
      },
      record: { read: async () => undefined, write: async () => {} },
      ownHelper: async () => ({ tag: OWN, baseImage: BASE }),
      referencesInUse: async () => ({ references: [], complete: true }),
      vm: false,
      buildx: PIN,
    });
    const notes = new RunReportBuilder(0);
    await expect(withRunNotes(notes, () => cleanup.pass())).resolves.toBeUndefined();
    expect(log).toContain('The cleanup of the engine failed: the clock broke');
    expect(notes.finish(0, true).events.partFailed).toEqual({ count: 1, items: ['the cleanup of the engine: the clock broke'] });
    // Outside a run (the look every 5 minutes) nothing is noted, and nothing throws.
    await expect(cleanup.observe()).resolves.toBeUndefined();
  });

  it('a failed removal is logged, and the tag stays in the record', async () => {
    const t = setup();
    typicalEngine(t.engine);
    t.setRecord(JSON.stringify({ helperTags: { [OLD]: START - 8 * DAY }, helperBases: {} }));
    t.engine.failing.add('removeImage');
    await t.cleanup.pass();
    expect(t.log).toContain(`Could not remove the tag ${OLD_MONITOR} of the image of a Monitor: removeImage failed`);
    expect(t.state().helperTags[OLD]).toBe(START - 8 * DAY);
  });

  it('a record that cannot be written is logged', async () => {
    const t = setup();
    t.failWrite();
    await t.cleanup.pass();
    expect(t.log).toContain('The record of the cleanup could not be written in the volume: the volume is full');
  });

  it('removes no helper tag as unused when the running containers cannot be listed in the pass', async () => {
    const t = setup();
    typicalEngine(t.engine);
    t.setRecord(JSON.stringify({ helperTags: { [OLD]: START - 8 * DAY }, helperBases: {} }));
    t.engine.failing.add('containerIds');
    await t.cleanup.pass();
    expect(t.engine.tags()).toContain(OLD);
    expect(t.engine.tags()).toContain(OLD_MONITOR);
    expect(t.state().helperTags[OLD]).toBe(START - 8 * DAY);
  });

  it('observe writes nothing when the containers of an image cannot be listed', async () => {
    const t = setup();
    typicalEngine(t.engine);
    t.engine.failing.add('containerIds');
    await t.cleanup.observe();
    expect(t.state()).toEqual({ helperTags: {}, helperBases: {} });
  });

  it('a look and a pass never run at the same time', async () => {
    const t = setup();
    typicalEngine(t.engine);
    const order: string[] = [];
    const port = t.engine.port();
    let inside = 0;
    const tracked = { ...port };
    for (const name of ['images', 'containerIds', 'inspect', 'removeImage'] as const) {
      const original = port[name] as (...args: unknown[]) => Promise<unknown>;
      (tracked as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        inside++;
        order.push(`${inside}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const result = await original(...args);
        inside--;
        return result;
      };
    }
    const serial = new EngineCleanup({
      engine: tracked,
      log: () => undefined,
      now: () => START,
      record: { read: async () => undefined, write: async () => undefined },
      ownHelper: async () => ({ tag: OWN, baseImage: BASE }),
      referencesInUse: async () => ({ references: [], complete: true }),
      vm: false,
      buildx: PIN,
    });
    await Promise.all([serial.observe(), serial.pass(), serial.observe()]);
    expect(order.every((depth) => depth === '1')).toBe(true);
  });
});
