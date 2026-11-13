// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker context `devspaces` of the setting devspaces.createDockerContext (R-ENG-007): on macOS and Linux the Docker
// socket of the Lima VM, which Lima carries into the folder of the instance (limaConfig, portForwards); on Windows the
// named pipe of the context (contextPipe.ts), which a window of Devspaces serves. It never becomes the current
// context. Devspaces reads the context store of the Docker CLI itself (`<DOCKER_CONFIG, else ~/.docker>/contexts/meta/
// <SHA-256 of the name>/meta.json`), so that it runs `docker context` only for a change, and it changes and removes
// only a context with its own description. No `vscode`.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envValue } from '../docker/dockerCli';
import { errorMessage } from '../errors';
import type { RunResult } from '../ports';
import { errorCode } from '../storage/paths';
import { isRecord } from '../valueChecks';

export const DOCKER_CONTEXT = 'devspaces';
/** The longest run of `docker context create`, `update` or `rm`, which reach no engine. */
export const DOCKER_CONTEXT_TIMEOUT_MS = 30_000;
/** The description of the context, by which Devspaces knows its own one. */
export const DOCKER_CONTEXT_DESCRIPTION = 'The VM of nimblescape Devspaces (setting devspaces.createDockerContext)';

/** The folder of the configuration of the Docker CLI: DOCKER_CONFIG, else ~/.docker. */
export function dockerConfigDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string = os.homedir()): string {
  const configured = envValue(env, 'DOCKER_CONFIG', platform);
  return configured !== undefined && configured !== '' ? configured : path.join(homeDir, '.docker');
}

/** The file of the context `name` in the context store of the Docker CLI. */
export function dockerContextFile(configDir: string, name: string = DOCKER_CONTEXT): string {
  return path.join(configDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json');
}

/** `ours`: the context has the description of Devspaces; `other`: another one, or one that cannot be read. */
export type DockerContextState = { kind: 'missing' } | { kind: 'ours'; host: string | undefined } | { kind: 'other' };

export function readDockerContext(file: string, read: (file: string) => string = (name) => fs.readFileSync(name, 'utf8')): DockerContextState {
  let text: string;
  try {
    text = read(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'other' };
  }
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return { kind: 'other' };
  }
  if (!isRecord(meta) || meta.Name !== DOCKER_CONTEXT || !isRecord(meta.Metadata) || meta.Metadata.Description !== DOCKER_CONTEXT_DESCRIPTION) return { kind: 'other' };
  const docker = isRecord(meta.Endpoints) && isRecord(meta.Endpoints.docker) ? meta.Endpoints.docker : undefined;
  return { kind: 'ours', host: typeof docker?.Host === 'string' ? docker.Host : undefined };
}

/**
 * `unchanged`: the context is as wanted; `taken`: a context `devspaces` that Devspaces did not create exists, and stays
 * as it is; `current`: the context is the current one of the Docker CLI, so it was not removed; `noCli`: a change is
 * needed, but this computer has no Docker CLI yet; `failed`: the Docker CLI failed (`detail`).
 */
export type DockerContextResult =
  | { kind: 'unchanged' | 'created' | 'updated' | 'removed' | 'taken' | 'noCli' }
  | { kind: 'current' | 'failed'; detail: string };

export interface DockerContextDeps {
  /** The file of the context (dockerContextFile). */
  file: string;
  /** Runs the Docker CLI with `args`, which reach no engine; undefined while this computer has no Docker CLI. */
  docker: ((args: string[]) => Promise<RunResult>) | undefined;
}

/**
 * A Docker host that `--docker host=<host>` takes as it is (the Docker CLI reads the value as CSV fields): `unix://`
 * with an absolute path, or a named pipe `npipe:////./pipe/<name>`, without commas, quotes and spaces.
 */
function usableHost(host: string): boolean {
  if (/[,"'\s]/.test(host)) return false;
  if (host.startsWith('unix://')) return path.posix.isAbsolute(host.slice('unix://'.length));
  return /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9._-]+$/.test(host);
}

/**
 * Makes the context `devspaces` point to the Docker host `host` (`unix://<socket>`, or `npipe:////./pipe/<name>`), or
 * removes it when `host` is undefined. Only a context with the description of Devspaces is changed or removed. Never
 * throws.
 */
export async function syncDockerContext(deps: DockerContextDeps, host: string | undefined): Promise<DockerContextResult> {
  const state = readDockerContext(deps.file);
  const done = (now: DockerContextState): boolean => (host === undefined ? now.kind !== 'ours' : now.kind === 'ours' && now.host === host);
  if (done(state)) return { kind: 'unchanged' };
  if (state.kind === 'other') return { kind: 'taken' };
  if (host !== undefined && !usableHost(host)) return { kind: 'failed', detail: `the Docker CLI cannot take the address: ${host}` };
  if (deps.docker === undefined) return { kind: 'noCli' };
  const args =
    host === undefined
      ? ['context', 'rm', DOCKER_CONTEXT]
      : state.kind === 'ours'
        ? ['context', 'update', DOCKER_CONTEXT, '--docker', `host=${host}`]
        : ['context', 'create', DOCKER_CONTEXT, '--description', DOCKER_CONTEXT_DESCRIPTION, '--docker', `host=${host}`];
  try {
    const result = await deps.docker(args);
    const detail = (result.stderr || result.stdout).trim().slice(-500);
    if (result.exitCode !== 0) {
      // Another window of this computer made the same change at the same time.
      if (done(readDockerContext(deps.file))) return { kind: 'unchanged' };
      return { kind: host === undefined && /\bin use\b/i.test(detail) ? 'current' : 'failed', detail: detail || `exit code ${result.exitCode}` };
    }
    return { kind: host === undefined ? 'removed' : state.kind === 'ours' ? 'updated' : 'created' };
  } catch (error) {
    return { kind: 'failed', detail: errorMessage(error) };
  }
}

/** The result of removeDockerContextFiles. */
export type DockerContextFilesResult = { kind: 'removed' | 'missing' | 'taken' | 'current' | 'unreadable' } | { kind: 'failed'; detail: string };

/**
 * Removes the context `devspaces` from the context store of the Docker CLI in `configDir` without the Docker CLI, as
 * `docker context rm` does: the folder of its metadata and the folder of its TLS files, both named by the SHA-256 of
 * the name. For the uninstall hook (src/uninstall/main.ts, R-GEN-008), which has no Docker CLI. Only a context with the
 * description of Devspaces goes (`taken`: another one stays). It stays while `environmentContext` (DOCKER_CONTEXT) names
 * it, and while `currentContext` of the `config.json` of the Docker CLI names it, also when DOCKER_CONTEXT names another
 * one (`current`): without the context, the Docker CLI would fail in every shell that has no DOCKER_CONTEXT. It also
 * stays while that file exists but cannot be read (`unreadable`), because then nobody can tell. Never throws.
 */
export async function removeDockerContextFiles(configDir: string, environmentContext?: string): Promise<DockerContextFilesResult> {
  const file = dockerContextFile(configDir);
  const state = readDockerContext(file);
  if (state.kind === 'missing') return { kind: 'missing' };
  if (state.kind === 'other') return { kind: 'taken' };
  try {
    const current = environmentContext === DOCKER_CONTEXT ? 'ours' : currentContextOf(configDir);
    if (current === 'ours') return { kind: 'current' };
    if (current === 'unknown') return { kind: 'unreadable' };
    const folder = path.dirname(file);
    await fs.promises.rm(path.join(configDir, 'contexts', 'tls', path.basename(folder)), { recursive: true, force: true });
    await fs.promises.rm(folder, { recursive: true, force: true });
    return { kind: 'removed' };
  } catch (error) {
    return { kind: 'failed', detail: errorMessage(error) };
  }
}

/**
 * Whether `currentContext` of the `config.json` in `configDir` names the context `devspaces`: `ours` when it does,
 * `unknown` when the file exists but cannot be read as JSON, `other` else (also without the file).
 */
function currentContextOf(configDir: string): 'ours' | 'unknown' | 'other' {
  let text: string;
  try {
    text = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'other' : 'unknown';
  }
  try {
    const config: unknown = JSON.parse(text);
    return isRecord(config) && config.currentContext === DOCKER_CONTEXT ? 'ours' : 'other';
  } catch {
    return 'unknown';
  }
}
