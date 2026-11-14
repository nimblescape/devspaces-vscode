// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The section "Layers" of the report of an image (docs/requirements.md R-ENG-010): the steps of its build from
// `docker image history`, each with what it added and when, the first step first. The history is metadata of the image,
// as its inspect; no file of the image is read. A step can name the values of build arguments, of ENV and of ARG, which
// can be secrets, so the report shows only their names (stepText). No `vscode`.
import { commandText, parseJsonLines, type BootstrapDocker } from '../docker/bootstrapDocker';
import { DOCKER_QUERY_TIMEOUT_MS } from '../docker/dockerTimeouts';
import { CommandError } from '../errors';
import { isRecord } from '../valueChecks';
import { formatSize } from './hostObjects';
import { cell, dockerTimeText, type ReportClock, type ReportSection } from './reportModel';

/** One step of the history of an image, as `docker image history` gives it. */
export interface ImageLayer {
  /** The instruction of the step (`CreatedBy`), as Docker gives it. */
  createdBy: string;
  /** The bytes that the step added (0 for a step that changed only the configuration). */
  size: number;
  /** When the step ran (RFC 3339), when Docker knows it. */
  createdAt?: string;
}

/** The most steps that the section shows (the newest ones; an image rarely has more). */
export const MAX_LAYERS = 200;
/** The most characters of a step in the section. */
export const MAX_STEP_LENGTH = 300;

/** The call of the history of the image `id`: all of each step, sizes in bytes, times in RFC 3339, one JSON line per step. */
export function imageHistoryArgs(id: string): string[] {
  return ['image', 'history', '--no-trunc', '--human=false', '--format', '{{json .}}', id];
}

/** The steps of the output of imageHistoryArgs, the newest first (as Docker gives them); a line that does not parse is left out. */
export function parseImageHistory(stdout: string): ImageLayer[] {
  return parseJsonLines(stdout).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const createdBy = typeof entry.CreatedBy === 'string' ? entry.CreatedBy : '';
    const size = typeof entry.Size === 'number' ? entry.Size : typeof entry.Size === 'string' && /^\d+$/.test(entry.Size) ? Number(entry.Size) : 0;
    const createdAt = typeof entry.CreatedAt === 'string' && entry.CreatedAt !== '' ? entry.CreatedAt : undefined;
    return [{ createdBy, size, ...(createdAt !== undefined ? { createdAt } : {}) }];
  });
}

/** The history of the image `id` on the host of the current operation. Throws a CommandError when Docker fails, and an AbortError. */
export async function readImageHistory(docker: Pick<BootstrapDocker, 'run'>, id: string, signal?: AbortSignal): Promise<ImageLayer[]> {
  const args = imageHistoryArgs(id);
  const result = await docker.run(args, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) {
    const stderr = result.timedOut ? `${result.stderr.trimEnd()}\nThe command did not end within the time limit.`.trim() : result.stderr;
    throw new CommandError(commandText(args), result.exitCode, result.stdout, stderr, result.timedOut);
  }
  return parseImageHistory(result.stdout);
}

/** A name of a variable. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A word `NAME=VALUE`, with its name. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
/** The shells with which Docker runs the shell form of RUN, after the build arguments. */
const SHELLS = ['/bin/sh -c ', '/bin/bash -c ', 'cmd /S /C '];

function clipped(text: string): string {
  return text.length <= MAX_STEP_LENGTH ? text : `${text.slice(0, MAX_STEP_LENGTH - 1)}…`;
}

/** The names of the variables of the words of ENV or ARG (`A=1 B=2`, or the older form `NAME value`). */
function variableNames(rest: string): string[] {
  const words = rest.split(/\s+/).filter((word) => word !== '');
  const names = words.map((word) => ASSIGNMENT.exec(word)?.[1]).filter((name): name is string => name !== undefined);
  if (names.length > 0) return names;
  return words.length > 0 && NAME.test(words[0]) ? [words[0]] : [];
}

/**
 * The step of a layer in words: the instruction without the shell that runs it, never a value of a build argument, of
 * ENV or of ARG (each can be a secret), at most MAX_STEP_LENGTH characters.
 *
 * - The classic builder writes `/bin/sh -c #(nop) <instruction>` for an instruction that runs nothing, and
 *   `/bin/sh -c <command>` or `|<N> <build arguments> /bin/sh -c <command>` for RUN; BuildKit writes the instruction
 *   (`RUN …`, `ENV …`) and ` # buildkit` at the end.
 * - The N words after `|<N>` are the build arguments, `NAME=VALUE`, which Docker writes without quotes. A value with a
 *   space would shift the words, so the command is shown only when the N words are assignments and the shell follows
 *   them; otherwise only that the step had N build arguments.
 */
export function stepText(createdBy: string): string {
  let text = createdBy.trim().replace(/\s+# buildkit$/, '');
  if (text === '') return '(no step recorded)';
  if (text.startsWith('/bin/sh -c #(nop) ')) text = text.slice('/bin/sh -c #(nop) '.length).trim();
  else if (text.startsWith('/bin/sh -c ') || /^\|\d+ /.test(text)) text = `RUN ${text}`;
  const instruction = /^([A-Z]+)(?:\s+(.*))?$/s.exec(text);
  const keyword = instruction?.[1];
  const rest = instruction?.[2] ?? '';
  if (keyword === 'ENV' || keyword === 'ARG') {
    // ARG NAME without a default has no value.
    if (keyword === 'ARG' && NAME.test(rest.trim())) return `ARG ${rest.trim()}`;
    const names = variableNames(rest);
    return clipped(names.length === 0 ? `${keyword} (not shown, because a value could be a secret)` : `${keyword} ${names.join(', ')} (the value${names.length === 1 ? ' is' : 's are'} not shown)`);
  }
  if (keyword === 'RUN') {
    const args = /^\|(\d+) (.*)$/s.exec(rest);
    if (args === null) return clipped(`RUN ${SHELLS.reduce((command, shell) => (command.startsWith(shell) ? command.slice(shell.length) : command), rest)}`);
    const count = Number(args[1]);
    const words = args[2].split(' ');
    const names = words.slice(0, count).map((word) => ASSIGNMENT.exec(word)?.[1]);
    const command = words.slice(count).join(' ');
    const shell = SHELLS.find((prefix) => command.startsWith(prefix));
    if (names.length !== count || names.some((name) => name === undefined) || shell === undefined) {
      return `RUN (a command with ${count} build argument${count === 1 ? '' : 's'}; not shown, because a value could be a secret)`;
    }
    return clipped(`RUN ${command.slice(shell.length)} (build argument${count === 1 ? '' : 's'} ${names.join(', ')})`);
  }
  return clipped(text);
}

/** The section "Layers" of the report of an image: its steps, the first one first, at most MAX_LAYERS (the newest). */
export function layersSection(layers: readonly ImageLayer[], clock: ReportClock): ReportSection {
  const shown = layers.slice(0, MAX_LAYERS).reverse();
  const left = layers.length - shown.length;
  const total = layers.reduce((sum, layer) => sum + layer.size, 0);
  return {
    title: 'Layers',
    body: {
      kind: 'table',
      columns: ['Step', 'Added', 'Created'],
      rows: shown.map((layer) => [cell(stepText(layer.createdBy)), cell(formatSize(layer.size)), cell(dockerTimeText(layer.createdAt, clock) ?? '')]),
      ...(left > 0 ? { more: `The ${left} earliest steps are left out.` } : {}),
      empty: 'Docker gives no steps for this image.',
    },
    from: `docker image history: the steps of the build of the image, the first one first, with the size that each step added (${layers.length} steps, ${formatSize(total)} in all). The values of build arguments, of ENV and of ARG are not shown, because they can be secrets.`,
  };
}
