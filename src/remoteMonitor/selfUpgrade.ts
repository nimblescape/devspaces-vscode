// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The move of the Monitor to the current build of its helper image (docs/requirements.md R-DS-009). When the Monitor
// (its background run, R-DS-003) or a window built the helper tag again, the Monitor container still runs from the
// earlier build. Between two ticks of its loop (main.ts), at most once per SELF_UPGRADE_CHECK_MS (a minute), when nothing
// runs (no part of the background run, no automatic stop, no end after the time without use) and the monitor does not end
// when idle at this tick (the next open creates it from the current build), check:
//   1. reads its own helper tag (the tag of its own Dockerfile, ownHelperImage) and its own script, and its own
//      container (found by the nonce of its create, MONITOR_CREATE_ID_ENV): its name, image, labels, variables, mounts,
//      and the commands of the windows that run in it (`docker exec`);
//   2. removes the containers of its name from earlier builds that ended (removeEarlier, below);
//   3. checks that it was created for its own helper tag: its label is that of its own script, of its helper tag, and
//      of its mode and store; a monitor of another tag (the Docker tests) never moves;
//   4. compares its image with the image of the helper tag now; the same image, or no image of the tag: nothing to do;
//   5. waits for the next check while a command of a window runs in its container, and for the removals of records
//      that run (RemoteMonitorLoop.removals);
//   6. sets its own restart policy to `no` (Docker never starts it again), and renames its container to
//      `<name>-earlier-<the first 12 hex digits of its ID>`, so the name is free;
//   7. tags the current build with its monitor tag, and creates its successor of the name from it, as a window creates
//      the monitor (RemoteSessionMonitor.createSuccessor: the same script, label, mode, store, schedule, variables and
//      mounts, the attached create with its ready line); a container of the name that a window created meanwhile
//      counts as the successor;
//   8. waits until no command of a window runs in its container (SELF_UPGRADE_COMMAND_WAIT_MS at most), and ends: the
//      loop exits with 0.
// While it moves (`ending`), no background run starts in it (CacheSchedule `holding`; a request of "Update All Images
// Now" stays in the volume for the successor). A failure before the successor runs puts the name and the restart policy
// back, is logged, and the monitor tries again after SELF_UPGRADE_RETRY_MS; when the name cannot be put back, the
// monitor ends anyway, so two monitors never run their loops on one engine (a window starts a monitor again at its next
// heartbeat). The successor starts with MONITOR_SUCCESSOR_ENV, so its start is no use of the engine (recordStart of
// main.ts). Each call of the engine has the time limit SELF_UPGRADE_TIMEOUT_MS (the create of the successor those of
// the ensure). Never throws. No `vscode`.
//
// removeEarlier: the containers of its own name from earlier builds (`<name>-earlier-…` with the label of a monitor)
// that ended are removed, each by its ID, and then the image of each, when it still exists (the image store of
// containerd removes it when its tag moves), has no tag, carries the label of a helper image, and is not the image of
// this monitor; Docker refuses an image that another container still uses (a worker of an earlier build), and the
// cleanup of the Monitor removes it later (engineCleanup.ts).
import { errorMessage } from '../core/errors';
import { monitorImageTag } from '../core/helper/helperState';
import { HELPER_DOCKER_SOCKET, LABEL_HELPER } from '../core/names';
import { type Logger, silentLogger } from '../core/ports';
import { LABEL_MONITOR, LABEL_MONITOR_CREATE, LABEL_MONITOR_OWNER, REMOTE_MONITOR_STATE_DIR, isMonitorCreateId, monitorModeOf } from '../core/remoteMonitor/protocol';
import {
  MONITOR_CREATE_ID_ENV,
  MONITOR_PERMANENT_ENV,
  MONITOR_SPEC_ENV,
  MONITOR_SPEC_LABELS,
  MONITOR_SUCCESSOR_ENV,
  MONITOR_VM_ENV,
  MONITOR_VSCODE_STORE_ENV,
  RemoteSessionMonitor,
  monitorLabel,
  type ImageMaintenanceSettings,
} from '../core/remoteMonitor/remoteSessionMonitor';
import { monitorRestartPolicy } from '../core/remoteMonitor/cacheSettings';
import { isRecord } from '../core/valueChecks';
import { engineMonitor } from '../core/worker/engineMonitor';
import { engineFailure, type UpgradeEngine } from './engine';

/** The time between two checks of the move. */
export const SELF_UPGRADE_CHECK_MS = 60_000;

/**
 * The time between two checks of the tests of the container (DEVSPACE_MONITOR_UPGRADE_CHECK_MS, 100 ms to
 * SELF_UPGRADE_CHECK_MS); without it, or with another value, SELF_UPGRADE_CHECK_MS.
 */
export function upgradeCheckFromEnv(env: NodeJS.ProcessEnv): number {
  const text = env.DEVSPACE_MONITOR_UPGRADE_CHECK_MS;
  if (text !== undefined && /^\d{3,5}$/.test(text) && Number(text) >= 100 && Number(text) <= SELF_UPGRADE_CHECK_MS) return Number(text);
  return SELF_UPGRADE_CHECK_MS;
}
/** The wait after a failed move before the next try. */
export const SELF_UPGRADE_RETRY_MS = 60 * 60_000;
/** The time limit of each call of the engine of the move (not the create of the successor: ensure's). */
export const SELF_UPGRADE_TIMEOUT_MS = 30_000;
/** The longest wait of the end for the commands of the windows that run in the container. */
export const SELF_UPGRADE_COMMAND_WAIT_MS = 30_000;
/** The wait between two looks at the commands of the windows during that wait. */
export const SELF_UPGRADE_COMMAND_LOOK_MS = 500;
/** The part of the name of a container of a monitor from an earlier build, after its own name. */
export const EARLIER_NAME_PART = '-earlier-';

export interface SelfUpgradeDeps {
  engine: UpgradeEngine;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  /** A monotonic clock in ms (the time between two checks). */
  monotonic: () => number;
  /** The script of this monitor (its stored file, REMOTE_MONITOR_SCRIPT_PATH). Rejects when it cannot be read. */
  script: () => Promise<string>;
  /** The helper tag of this monitor (the tag of its own Dockerfile, ownHelperImage); undefined when it cannot be read. */
  helperTag: () => Promise<string | undefined>;
  /** True while a part of the background run runs (CacheSchedule.busy): then nothing moves. */
  busy: () => boolean;
  /** The removals of records that run (RemoteMonitorLoop.removals): a move waits for them. */
  removals: () => Promise<void> | undefined;
  /** The wait between two looks at the commands of the windows (the tests). */
  sleep?: (ms: number) => Promise<void>;
  /** The time between two checks (default SELF_UPGRADE_CHECK_MS; upgradeCheckFromEnv for the tests of the container). */
  checkMs?: number;
}

/** The own container of the monitor as the move reads it. */
interface OwnContainer {
  id: string;
  /** Its name without the leading `/`. */
  name: string;
  /** The ID of its image. */
  image: string;
  labels: Record<string, string>;
  /** Its variables as `KEY=VALUE`. */
  env: string[];
  /** Its bind mounts as created (`source:target`). */
  binds: string[];
  /** The IDs of the processes that `docker exec` created in it and that did not end (running or never started). */
  execIds: string[];
}

/** The image of an inspect: its ID, labels, variables and tags. */
interface ImageConfig {
  id: string;
  labels: Record<string, string>;
  env: string[];
  tags: string[];
}

/** The move of the monitor to the current build of its helper image (see the module comment). */
export class SelfUpgrade {
  /** The monotonic time of the next check (0: at the first chance). */
  private nextAt = 0;
  /** It never moves: no nonce, no helper tag of its own, or a label of another helper tag. */
  private disabled = false;
  /** Its helper tag, once its label matched it (then neither its script nor its Dockerfile is read again). */
  private tag: string | undefined;
  /** A failure of the reads was logged (once until a check reads again). */
  private readFailureLogged = false;
  /** It moves now: no background run starts (CacheSchedule `holding`). */
  ending = false;

  constructor(private readonly deps: SelfUpgradeDeps) {}

  /** True when a check is due (between two ticks). */
  due(): boolean {
    return !this.disabled && !this.ending && this.deps.monotonic() >= this.nextAt;
  }

  /**
   * One check (see the module comment): true when the successor runs and this monitor ends now (the loop exits with
   * 0). Never throws.
   */
  async check(): Promise<boolean> {
    const { log, monotonic } = this.deps;
    this.nextAt = monotonic() + (this.deps.checkMs ?? SELF_UPGRADE_CHECK_MS);
    const createId = this.deps.env[MONITOR_CREATE_ID_ENV];
    if (!isMonitorCreateId(createId)) {
      this.disabled = true;
      return false;
    }
    // Its own files first, until its label matched once (neither changes while the container lives): without its
    // helper tag (the tests of main.ts) it never looks at the engine.
    let tag = this.tag;
    let script: string | undefined;
    if (tag === undefined) {
      try {
        tag = await this.deps.helperTag();
        if (tag === undefined) {
          this.disabled = true;
          return false;
        }
        script = await this.deps.script();
      } catch (error) {
        log(`The Monitor cannot read its own script, so it never moves to a newer build of its helper image: ${errorMessage(error).replace(/\.$/, '')}.`);
        this.disabled = true;
        return false;
      }
    }
    let own: OwnContainer;
    try {
      own = await this.ownContainer(createId);
      await this.removeEarlier(own);
    } catch (error) {
      if (!this.readFailureLogged) log(`The Monitor cannot check whether it runs from the current build of its helper image: ${errorMessage(error).replace(/\.$/, '')}.`);
      this.readFailureLogged = true;
      return false;
    }
    const images = this.imageMaintenance(own);
    const store = this.deps.env[MONITOR_VSCODE_STORE_ENV];
    if (script !== undefined) {
      if (own.labels[LABEL_MONITOR] !== monitorLabel(script, tag, monitorModeOf(images), store)) {
        this.disabled = true;
        return false;
      }
      this.tag = tag;
    }
    let current: ImageConfig | undefined;
    let earlier: ImageConfig | undefined;
    let running: boolean;
    try {
      current = await this.imageConfig(tag);
      if (current === undefined || current.id === own.image) {
        this.readFailureLogged = false;
        return false;
      }
      earlier = await this.imageConfig(own.image);
      running = await this.commandsRun(own.execIds);
    } catch (error) {
      if (!this.readFailureLogged) log(`The Monitor cannot check whether it runs from the current build of its helper image: ${errorMessage(error).replace(/\.$/, '')}.`);
      this.readFailureLogged = true;
      return false;
    }
    this.readFailureLogged = false;
    // A command of a window runs in its container (a heartbeat, the forget of a Delete): the next check.
    if (running) return false;
    await this.deps.removals();
    // From here on no background run starts; one that started meanwhile defers the move.
    this.ending = true;
    if (this.deps.busy()) {
      this.ending = false;
      return false;
    }
    log(`The helper image ${tag} was built again (${shortId(own.image)} → ${shortId(current.id)}). The Monitor moves to the current build: it creates its successor ${own.name} from it, and then ends.`);
    const moved = await this.move(own, tag, current, earlier, images, store);
    if (moved) await this.waitForCommands(own.id);
    else this.ending = false;
    return moved;
  }

  /**
   * Steps 6 and 7 of the module comment: true when the successor runs (or this monitor must end anyway), false when it
   * goes on (its name and restart policy back; the next try after SELF_UPGRADE_RETRY_MS). Logs the outcome.
   */
  private async move(own: OwnContainer, tag: string, current: ImageConfig, earlier: ImageConfig | undefined, images: ImageMaintenanceSettings | undefined, store: string | undefined): Promise<boolean> {
    const { engine, log } = this.deps;
    const socket = bindSource(own.binds, HELPER_DOCKER_SOCKET);
    const volume = bindSource(own.binds, REMOTE_MONITOR_STATE_DIR);
    if (socket === undefined || volume === undefined) return this.failed(`its container has no mount of ${socket === undefined ? 'the socket of the engine' : 'its volume'}`);
    const policy = monitorRestartPolicy(images?.permanent === true);
    try {
      await engine.updateRestartPolicy(own.id, 'no', limit());
    } catch (error) {
      return this.failed(`its restart policy could not be changed: ${engineFailure(error, SELF_UPGRADE_TIMEOUT_MS)}`);
    }
    const earlierName = `${own.name}${EARLIER_NAME_PART}${own.id.slice(0, 12)}`;
    try {
      await engine.renameContainer(own.id, earlierName, limit());
    } catch (error) {
      return this.putBack(own, policy, false, `its container could not be renamed: ${engineFailure(error, SELF_UPGRADE_TIMEOUT_MS)}`);
    }
    let reference = current.id;
    const monitorTag = monitorImageTag(tag);
    if (monitorTag !== undefined) {
      try {
        await engine.tagImage(current.id, monitorTag, limit());
        reference = monitorTag;
      } catch (error) {
        log(`The current build could not be tagged as ${monitorTag}; the successor runs from ${shortId(current.id)}: ${engineFailure(error, SELF_UPGRADE_TIMEOUT_MS)}`);
      }
    }
    // The image of the earlier build may be gone already (see ownLabels).
    const builds = earlier === undefined ? [current] : [current, earlier];
    const successor = new RemoteSessionMonitor({
      engine: engineMonitor(engine),
      logger: logOnly(log),
      script: this.deps.script,
      ...(images !== undefined ? { imageMaintenance: () => images } : {}),
      ...(store !== undefined ? { vscodeStoreVolume: store } : {}),
      containerName: own.name,
      volumeName: volume,
      labels: ownLabels(own.labels, builds),
      containerEnv: { ...ownEnv(own.env, builds), [MONITOR_SUCCESSOR_ENV]: '1' },
    });
    let outcome: Awaited<ReturnType<RemoteSessionMonitor['createSuccessor']>>;
    try {
      outcome = await successor.createSuccessor(tag, socket, reference, current.id);
    } catch (error) {
      return this.putBack(own, policy, true, `its successor could not be created: ${errorMessage(error).replace(/\.$/, '')}`);
    }
    log(
      outcome === 'created'
        ? `The successor ${own.name} runs from the current build of the helper image. This Monitor (now ${earlierName}) ends; the successor removes it.`
        : `A window created the Monitor ${own.name} meanwhile. This Monitor (now ${earlierName}) ends; the next Monitor removes it.`,
    );
    return true;
  }

  /**
   * After a failure once the restart policy is `no`: the name back (when it was renamed) and the restart policy back.
   * False when both are back (it goes on, the next try after SELF_UPGRADE_RETRY_MS); true when the name cannot be put
   * back (it ends: a window starts a monitor again at its next heartbeat). A policy that cannot be put back keeps it
   * going with `no` (logged; the next ensure of a window replaces it).
   */
  private async putBack(own: OwnContainer, policy: 'on-failure' | 'unless-stopped', renamed: boolean, reason: string): Promise<boolean> {
    const { engine, log } = this.deps;
    if (renamed) {
      try {
        await engine.renameContainer(own.id, own.name, limit());
      } catch (error) {
        log(`The Monitor could not move to the current build of its helper image (${reason}), and its name could not be put back (${engineFailure(error, SELF_UPGRADE_TIMEOUT_MS).replace(/\.$/, '')}). It ends; the next heartbeat of a window starts the Monitor again.`);
        return true;
      }
    }
    try {
      await engine.updateRestartPolicy(own.id, policy, limit());
    } catch (error) {
      log(`The restart policy "${policy}" of the Monitor could not be put back: ${engineFailure(error, SELF_UPGRADE_TIMEOUT_MS)}`);
    }
    return this.failed(reason);
  }

  /** A failed move: logged, the next try after SELF_UPGRADE_RETRY_MS; false (it goes on). */
  private failed(reason: string): false {
    this.nextAt = this.deps.monotonic() + SELF_UPGRADE_RETRY_MS;
    this.deps.log(`The Monitor could not move to the current build of its helper image (${reason.replace(/\.$/, '')}). It tries again in ${SELF_UPGRADE_RETRY_MS / 60_000} minutes.`);
    return false;
  }

  /**
   * Step 2 of the module comment: the containers of the name of `own` from earlier builds that ended, and their images
   * (see removeEarlier in the module comment). A list that fails throws (the check logs it); each removal that fails is
   * logged and tried again at the next check.
   */
  private async removeEarlier(own: OwnContainer): Promise<void> {
    const { engine, log } = this.deps;
    const prefix = `${own.name}${EARLIER_NAME_PART}`;
    const listed = await engine.containerSummaries(LABEL_MONITOR, limit());
    for (const container of listed) {
      if (!container.name.startsWith(prefix) || !['exited', 'dead', 'created'].includes(container.state) || container.id === own.id) continue;
      try {
        const image = imageOf(await engine.inspect('container', container.id, limit()));
        await engine.removeContainer(container.id, limit());
        log(`Removed the Monitor ${container.name} of an earlier build of the helper image.`);
        if (image === undefined || image === own.image) continue;
        const config = await this.imageConfig(image);
        if (config === undefined || config.tags.length > 0 || config.labels[LABEL_HELPER] === undefined) continue;
        if ((await engine.removeImage(image, limit())) === 'removed') log(`Removed the earlier build ${shortId(image)} of the helper image.`);
      } catch (error) {
        log(`The Monitor ${container.name} of an earlier build could not be removed: ${engineFailure(error, SELF_UPGRADE_TIMEOUT_MS)}`);
      }
    }
  }

  /** The settings of the background run of the monitor, as its creator gave them (its variables and owner label). */
  private imageMaintenance(own: OwnContainer): ImageMaintenanceSettings | undefined {
    const { env } = this.deps;
    const schedule = env.DEVSPACE_IMAGE_SCHEDULE;
    const timeZone = env.DEVSPACE_IMAGE_TZ;
    if (schedule === undefined || timeZone === undefined) return undefined;
    const permanent = env[MONITOR_PERMANENT_ENV] === '1';
    const computer = own.labels[LABEL_MONITOR_OWNER];
    return {
      schedule,
      timeZone,
      ...(permanent ? { permanent: true } : {}),
      ...(permanent && computer !== undefined ? { computer } : {}),
      ...(env[MONITOR_VM_ENV] === '1' ? { vm: true } : {}),
    };
  }

  /** Its own container, by the nonce of its create; throws when it is not exactly one or cannot be read. */
  private async ownContainer(createId: string): Promise<OwnContainer> {
    const { engine } = this.deps;
    const ids = await engine.containerIds({ label: [`${LABEL_MONITOR_CREATE}=${createId}`] }, limit());
    if (ids.length !== 1) throw new Error(`${ids.length} containers have the nonce of its create`);
    const own = ownContainerOf(await engine.inspect('container', ids[0], limit()));
    if (own === undefined) throw new Error('the inspect of its container is not complete');
    return own;
  }

  /** The image `reference` (a tag or an ID); undefined when it does not exist; throws when it cannot be read. */
  private async imageConfig(reference: string): Promise<ImageConfig | undefined> {
    const value = await this.deps.engine.inspect('image', reference, limit());
    if (value === undefined) return undefined;
    const config = imageConfigOf(value);
    if (config === undefined) throw new Error(`the inspect of the image ${reference} is not complete`);
    return config;
  }

  /**
   * Whether a command of a window runs in the container: one of `execIds` that runs (an inspect that fails counts as
   * running; a process that is gone does not).
   */
  private async commandsRun(execIds: readonly string[]): Promise<boolean> {
    for (const id of execIds) {
      let value: unknown;
      try {
        value = await this.deps.engine.inspect('exec', id, limit());
      } catch {
        return true;
      }
      if (isRecord(value) && value.Running === true) return true;
    }
    return false;
  }

  /** Step 8: until no command of a window runs in the container `id`, SELF_UPGRADE_COMMAND_WAIT_MS at most. */
  private async waitForCommands(id: string): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; waited < SELF_UPGRADE_COMMAND_WAIT_MS; waited += SELF_UPGRADE_COMMAND_LOOK_MS) {
      let running = true;
      try {
        const own = ownContainerOf(await this.deps.engine.inspect('container', id, limit()));
        running = own === undefined || (await this.commandsRun(own.execIds));
      } catch {
        // Looked at again.
      }
      if (!running) return;
      await sleep(SELF_UPGRADE_COMMAND_LOOK_MS);
    }
  }
}

/** The time limit of one call of the engine. */
function limit(): AbortSignal {
  return AbortSignal.timeout(SELF_UPGRADE_TIMEOUT_MS);
}

/** The first 12 hex digits of an image ID, for the log. */
function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

/** A Logger whose lines go to `log` (the ensure of the successor logs nothing of its own on success). */
function logOnly(log: (message: string) => void): Logger {
  return { ...silentLogger, info: log, warn: log, error: (message) => log(message) };
}

/** The source of the bind mount at `target` (`source:target` as the create wrote it); undefined when there is none. */
export function bindSource(binds: readonly string[], target: string): string | undefined {
  const suffix = `:${target}`;
  const bind = binds.find((entry) => entry.endsWith(suffix) && entry.length > suffix.length);
  return bind?.slice(0, -suffix.length);
}

/**
 * The labels that the successor takes from its predecessor: those of its container that runSpec does not set
 * (MONITOR_SPEC_LABELS) and whose key no image of `images` has (the labels of the helper image: the successor gets
 * those of the current build from its image, never the values of the earlier build). By the key, because the image of
 * the earlier build may be gone (the image store of containerd removes it when its tag moves, even while a container
 * runs from it); a creator of the monitor never sets a label of the helper image.
 */
export function ownLabels(labels: Readonly<Record<string, string>>, images: readonly Pick<ImageConfig, 'labels'>[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (MONITOR_SPEC_LABELS.includes(key) || images.some((image) => Object.hasOwn(image.labels, key))) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * The variables that the successor takes from its predecessor: those of its container that runSpec does not set
 * (MONITOR_SPEC_ENV) and whose key no image of `images` has (as ownLabels: by the key; a creator of the monitor never
 * sets a variable of the helper image).
 */
export function ownEnv(env: readonly string[], images: readonly Pick<ImageConfig, 'env'>[]): Record<string, string> {
  const imageKeys = new Set(images.flatMap((image) => image.env.map((entry) => entry.slice(0, Math.max(0, entry.indexOf('='))))));
  const kept: Record<string, string> = {};
  for (const entry of env) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const key = entry.slice(0, at);
    if (MONITOR_SPEC_ENV.includes(key) || imageKeys.has(key)) continue;
    kept[key] = entry.slice(at + 1);
  }
  return kept;
}

/** The ID of the image of a container inspect; undefined when it has none. */
function imageOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.Image === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.Image) ? value.Image : undefined;
}

/** A record of strings (labels); empty for anything else. */
function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (!isRecord(value)) return record;
  for (const [key, entry] of Object.entries(value)) if (typeof entry === 'string') record[key] = entry;
  return record;
}

/** A list of strings; empty for anything else (Docker writes `null` for an empty list). */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** The own container of a container inspect; undefined when its ID, name or image cannot be read. */
export function ownContainerOf(value: unknown): OwnContainer | undefined {
  if (!isRecord(value)) return undefined;
  const config = isRecord(value.Config) ? value.Config : {};
  const host = isRecord(value.HostConfig) ? value.HostConfig : {};
  const image = imageOf(value);
  const { Id: id, Name: name } = value;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id) || typeof name !== 'string' || !/^\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || image === undefined) return undefined;
  return {
    id,
    name: name.slice(1),
    image,
    labels: stringRecord(config.Labels),
    env: strings(config.Env),
    binds: strings(host.Binds),
    execIds: strings(value.ExecIDs),
  };
}

/** The image of an image inspect; undefined when its ID cannot be read. */
function imageConfigOf(value: unknown): ImageConfig | undefined {
  if (!isRecord(value) || typeof value.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.Id)) return undefined;
  const config = isRecord(value.Config) ? value.Config : {};
  return { id: value.Id, labels: stringRecord(config.Labels), env: strings(config.Env), tags: strings(value.RepoTags) };
}
