// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reads of the report of one resource of the view Docker Hosts (docs/requirements.md R-ENG-010), within an operation
// on its host on the shared shell (runWithDockerTarget with `onShell`): the facts of Docker of the object, and for a
// report that needs the shared volumes (reportVolumes) the volumes that exist, the helper images that may run the reader,
// the platform of the engine, and one run of the reader. Only calls that read, and the reader, which only reads; nothing
// is pulled. No `vscode`.
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { dockerCommandWords } from '../docker/dockerCli';
import { CommandError, errorMessage } from '../errors';
import type { VscodePlatform } from '../helperChannel/protocol';
import { isAbortError, type RunResult } from '../ports';
import { readableStderr } from '../loader/pipeLoader';
import { serverPlatform } from '../worker/vscodeStoreLayout';
import type { HostObject } from './hostObjects';
import type { ReportComputer } from './monitorReport';
import { readObjectDetails, type ObjectDetails } from './objectDetails';
import type { ReportClock, ReportContent } from './reportModel';
import { reportVolumes, resourceReport } from './resourceReport';
import { READER_VOLUMES, readSharedVolumesSafely, readerImages, type ReaderVolumeNames, type VolumeReadOutcome } from './volumeReader';

/** The most characters of the errors of a call that a report keeps (its end). */
const ERROR_LENGTH = 2000;

/** The readable lines of the end of the errors of a call. */
function errorText(stderr: string): string {
  return readableStderr(stderr.slice(-ERROR_LENGTH), ERROR_LENGTH);
}

/** The time limit of each list of a report (the volumes, the helper images, the platform). */
const LIST_TIMEOUT_MS = 30_000;

export interface ReportReadInput {
  object: HostObject;
  /** The helper tag of this version of Devspaces (helperImageTag): the reader tries it first. */
  currentHelperTag?: string;
  computer: ReportComputer;
  clock: ReportClock;
  signal?: AbortSignal;
}

/** One read call; a CommandError when Docker fails or the call times out. */
async function readLines(docker: Pick<BootstrapDocker, 'run'>, args: string[], signal: AbortSignal | undefined): Promise<string[]> {
  const result: RunResult = await docker.run(args, { timeoutMs: LIST_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) {
    const stderr = result.timedOut ? `${result.stderr.trimEnd()}\nThe command did not end within the time limit.`.trim() : result.stderr;
    throw new CommandError(`docker ${dockerCommandWords(args).join(' ')}`, result.exitCode, '', errorText(stderr), result.timedOut);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The volumes of `wanted` that exist on the host (the reader mounts only those: a mount of a missing volume creates it). */
function existingVolumes(wanted: ReaderVolumeNames, names: ReadonlySet<string>): ReaderVolumeNames {
  const found: ReaderVolumeNames = {};
  for (const key of READER_VOLUMES) {
    const name = wanted[key];
    if (name !== undefined && names.has(name)) found[key] = name;
  }
  return found;
}

/**
 * The shared volumes that the report of `object` needs, read with the reader: the volumes that exist, the helper images
 * on the host (readerImages), and for the store of VS Code the platform of the engine (the Monitor cleans only its
 * server versions). A failed list gives a failed read with its reason; only an AbortError is thrown.
 */
async function readVolumes(docker: Pick<BootstrapDocker, 'run'>, wanted: ReaderVolumeNames, input: ReportReadInput): Promise<{ volumes: VolumeReadOutcome; platform?: VscodePlatform }> {
  const { signal } = input;
  try {
    const names = new Set(await readLines(docker, ['volume', 'ls', '--format', '{{.Name}}'], signal));
    const volumes = existingVolumes(wanted, names);
    if (!READER_VOLUMES.some((key) => volumes[key] !== undefined)) return { volumes: { kind: 'noVolume' } };
    const tags = await readLines(docker, ['image', 'ls', '--filter', 'reference=devspaces-worker', '--filter', 'reference=devspaces-monitor', '--format', '{{.Repository}}:{{.Tag}}'], signal);
    // The platform is only for the rules of the store; without it, the report says that it is not known.
    let platform: VscodePlatform | undefined;
    if (volumes.vscode !== undefined) {
      try {
        platform = serverPlatform((await readLines(docker, ['info', '--format', '{{.Architecture}}'], signal))[0] ?? '');
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    const outcome = await readSharedVolumesSafely(docker, { images: readerImages(tags, input.currentHelperTag), volumes, ...(signal !== undefined ? { signal } : {}) });
    return { volumes: outcome, ...(platform !== undefined ? { platform } : {}) };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { volumes: { kind: 'failed', detail: errorMessage(error) } };
  }
}

/**
 * The report of `input.object`, read now within an operation on its host: its facts of Docker (a failure is a note of
 * the report), and the shared volumes when the report needs them. Throws only an AbortError (and the errors of a Docker
 * CLI that cannot run).
 */
export async function readResourceReport(docker: Pick<BootstrapDocker, 'run'>, input: ReportReadInput): Promise<ReportContent> {
  const { object, signal } = input;
  let details: ObjectDetails | undefined;
  let detailsProblem: string | undefined;
  try {
    details = await readObjectDetails(docker, object, signal);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    detailsProblem = errorText(error.stderr) || error.message;
  }
  const wanted = reportVolumes(object);
  const read = READER_VOLUMES.some((key) => wanted[key] !== undefined) ? await readVolumes(docker, wanted, input) : undefined;
  return resourceReport({
    object,
    ...(details !== undefined ? { details } : {}),
    ...(detailsProblem !== undefined ? { detailsProblem } : {}),
    ...(read !== undefined ? { volumes: read.volumes } : {}),
    ...(read?.platform !== undefined ? { platform: read.platform } : {}),
    computer: input.computer,
    clock: input.clock,
  });
}
