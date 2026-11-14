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
/**
 * The marker of the classic builder for an instruction that runs nothing, after the shell of the image: `/bin/sh -c`,
 * the shell of a SHELL instruction (for example `/bin/bash -o pipefail -c`), or `cmd /S /C` on Windows.
 */
const NOP = /^.*?#\(nop\)\s+(.*)$/s;
/** A step that starts with its instruction (BuildKit, or the classic builder after NOP). */
const INSTRUCTION = /^[A-Z]+(?:\s|$)/;

function clipped(text: string): string {
  return text.length <= MAX_STEP_LENGTH ? text : `${text.slice(0, MAX_STEP_LENGTH - 1)}…`;
}

/**
 * ENV or ARG in words, without a value. Docker writes the values without quotes, so a value with a space and a `=`
 * looks like one more variable (`A=x y=z` can be A with the value `x y=z`): only the name of the first word is certain,
 * and further words show as `…`. The first word is `NAME=VALUE`, or `NAME` (the older form `ENV NAME value`, whose rest
 * is the value, and ARG without a default). ARG with only names has no value and shows them all.
 */
function variablesText(keyword: 'ENV' | 'ARG', rest: string): string {
  const words = rest.split(/\s+/).filter((word) => word !== '');
  if (keyword === 'ARG' && words.length > 0 && words.every((word) => NAME.test(word))) return `ARG ${words.join(', ')}`;
  const first = words[0];
  const name = first === undefined ? undefined : NAME.test(first) ? first : ASSIGNMENT.exec(first)?.[1];
  if (name === undefined) return `${keyword} (not shown, because a value could be a secret)`;
  // The older form: one variable, the rest of the words is its value.
  const one = words.length === 1 || (keyword === 'ENV' && NAME.test(first ?? ''));
  return one ? `${keyword} ${name} (the value is not shown)` : `${keyword} ${name}, … (the values are not shown)`;
}

/**
 * The step of a layer in words: the instruction without the shell that runs it, never a value of a build argument, of
 * ENV or of ARG (each can be a secret), at most MAX_STEP_LENGTH characters.
 *
 * - The classic builder writes `<shell> #(nop) <instruction>` for an instruction that runs nothing (NOP), and
 *   `/bin/sh -c <command>` or `|<N> <build arguments> /bin/sh -c <command>` for RUN; BuildKit writes the instruction
 *   (`RUN …`, `ENV …`) and ` # buildkit` at the end.
 * - ONBUILD gets the same rules for the instruction that it holds.
 * - The N words after `|<N>` are the build arguments, `NAME=VALUE`, which Docker writes without quotes. A value with a
 *   space would shift the words, so the command is shown only when the N words are assignments and the shell follows
 *   them; otherwise only that the step had N build arguments.
 */
export function stepText(createdBy: string): string {
  let text = createdBy.trim().replace(/\s+# buildkit$/, '');
  if (text === '') return '(no step recorded)';
  const nop = INSTRUCTION.test(text) ? null : NOP.exec(text);
  if (nop !== null) text = nop[1].trim();
  else if (SHELLS.some((shell) => text.startsWith(shell)) || /^\|\d+ /.test(text)) text = `RUN ${text}`;
  const instruction = /^([A-Z]+)(?:\s+(.*))?$/s.exec(text);
  const keyword = instruction?.[1];
  const rest = instruction?.[2] ?? '';
  if (keyword === 'ENV' || keyword === 'ARG') return clipped(variablesText(keyword, rest));
  // ONBUILD holds an instruction of a later build (`ONBUILD ENV TOKEN=…`): the same rules for it.
  if (keyword === 'ONBUILD') return clipped(`ONBUILD ${INSTRUCTION.test(rest) ? stepText(rest) : '(not shown, because a value could be a secret)'}`);
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
    if (count === 0) return clipped(`RUN ${command.slice(shell.length)}`);
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
