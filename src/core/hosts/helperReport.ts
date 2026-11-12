// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the helper containers of Devspaces in the view Docker Hosts (docs/requirements.md R-ENG-010): a worker
// (the window that it serves, its helper image, and when it ends), a batch helper (the volumes of its step, and when it
// is removed), and a build container of the helper image. From the name, the labels and the facts of Docker of the
// container. Before the facts of Docker (resourceReport.ts). Pure; no I/O.
import { isDevspaceResourceName, resourceName } from '../names';
import type { HostObject } from './hostObjects';
import type { ReportComputer } from './monitorReport';
import type { ObjectDetails } from './objectDetails';
import { chip, fact, itemsText, type ReportContent, type ReportFact } from './reportModel';

export interface HelperReportInput {
  object: HostObject;
  details?: ObjectDetails;
  computer: ReportComputer;
  /** The helper tag of this version of Devspaces (helperImageTag), when it is known. */
  currentHelperTag?: string;
}

/** Whether the report of `object` has a part of this module (helperReport gives it). */
export function isHelperContainer(object: Pick<HostObject, 'kind' | 'purpose'>): boolean {
  return object.kind === 'container' && (object.purpose === 'worker' || object.purpose === 'batchHelper' || object.purpose === 'buildContainer');
}

/** The end of the name of a worker: `-worker` and its number (workerContainerBase in names.ts). */
const WORKER_NAME = /^(.+)-worker\d+$/;

/** The window that a worker serves, in words, from its name. */
function windowText(name: string, computer: ReportComputer): string {
  const base = WORKER_NAME.exec(name)?.[1];
  if (base === undefined) return 'not known: the name has no number of a worker';
  for (const devspace of computer.devspaces?.values() ?? []) {
    if (resourceName(devspace.repository, devspace.id) === base) return `the window of the devspace ${devspace.repository}`;
  }
  return isDevspaceResourceName(base) ? 'the window of a devspace that this computer does not know' : 'a window of VS Code that is not connected to a devspace';
}

/** The fact of the image of a helper container: its helper tag, and whether it is the one of this version of Devspaces. */
function imageFact(input: HelperReportInput): ReportFact | undefined {
  const image = (input.details?.kind === 'container' ? input.details.image : undefined) ?? input.object.image;
  if (image === undefined) return undefined;
  if (input.currentHelperTag === undefined) return fact('Image', image);
  return fact('Image', image, image === input.currentHelperTag ? chip('the helper image of this version of Devspaces', 'keep') : undefined);
}

/** The part of the report of a helper container (isHelperContainer); undefined for another object. */
export function helperReport(input: HelperReportInput): ReportContent | undefined {
  const { object, details, computer } = input;
  if (!isHelperContainer(object)) return undefined;
  const facts: ReportFact[] = [];
  let title: string;
  switch (object.purpose) {
    case 'worker':
      title = 'The worker';
      facts.push(fact('Serves', windowText(object.name, computer)));
      break;
    case 'batchHelper': {
      title = 'The batch helper';
      const volumes = details?.kind === 'container' ? details.mounts.filter((mount) => mount.type === 'volume').map((mount) => mount.source) : [];
      facts.push(fact('Volumes of its step', volumes.length > 0 ? itemsText(volumes, 10) : 'none'));
      break;
    }
    default:
      title = 'The build container';
      facts.push(fact('Builds', 'the helper image, with buildx of the build image devspaces-buildx'));
  }
  const image = imageFact(input);
  if (image !== undefined) facts.push(image);
  switch (object.purpose) {
    case 'worker':
      facts.push(fact('Ends', 'with its window; after a new build of the helper image, the window moves to a worker of the new build', chip('rule of the worker', 'info')));
      break;
    case 'batchHelper':
      facts.push(fact('Ends', 'removed by the worker at the end of its step; a stopped one older than 10 minutes goes at the next run of the Monitor, or when a window connects to this engine', chip('rule of the worker', 'info')));
      break;
    default:
      facts.push(fact('Ends', 'removed at the end of its build', chip('rule of the build', 'info')));
  }
  return {
    summary: [],
    sections: [{ title, body: { kind: 'facts', facts }, from: 'From the name, the labels and the mounts of the container, and docker container inspect.' }],
    notices: [],
    monitorLog: false,
  };
}
