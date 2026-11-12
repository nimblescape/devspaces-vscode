// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build context of a shared image built from a Dockerfile (R-DS-010): its hash in READ_FILES_SCRIPT (contextTree),
// and the checked copy that WRITE_AND_RUN_SCRIPT makes for the build. Real folders, a fake `devcontainer`.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_COPY_FOLDER, LOCKFILE_CHANGED_EXIT, LOCKFILE_CHANGED_TEXT, MAX_CONTEXT_ENTRIES, WRITE_AND_RUN_SCRIPT, readFilesCommand } from './scripts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-context-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // A folder without the write bit of its owner (a test of the modes) is removed after its mode is given back.
    spawnSync('chmod', ['-R', 'u+rwx', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const CONFIG = '{ "build": { "dockerfile": "Dockerfile" } }';
const DOCKERFILE = 'FROM node:24\nCOPY . /app\n';

/** A repository with a configuration whose Dockerfile and build context are `.devcontainer`, and a few files in it. */
function repository(): string {
  const repo = path.join(tempDir(), 'repo');
  write(path.join(repo, '.devcontainer', 'devcontainer.json'), CONFIG);
  write(path.join(repo, '.devcontainer', 'Dockerfile'), DOCKERFILE);
  write(path.join(repo, '.devcontainer', '.dockerignore'), 'node_modules\n');
  write(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), '#!/bin/sh\necho setup\n');
  fs.chmodSync(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), 0o755);
  fs.symlinkSync('scripts/setup.sh', path.join(repo, '.devcontainer', 'setup'));
  write(path.join(repo, 'src', 'index.ts'), 'export {};\n');
  return repo;
}

/** READ_FILES_SCRIPT with the build context `context` (relative to the repository): its JSON line. */
function read(repo: string, context = '.devcontainer', dockerfile?: string): Record<string, unknown> {
  const command = readFilesCommand(repo, '.devcontainer/devcontainer.json', dockerfile, context);
  const result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function hashOf(repo: string, context = '.devcontainer'): string {
  const value = read(repo, context);
  expect(value.contextUnhashable).toBeUndefined();
  expect(value.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  return value.contextHash as string;
}

describe('READ_FILES_SCRIPT: the hash of the build context', () => {
  it('gives the same hash for the same files, whatever their times and the folder of the repository', () => {
    const repo = repository();
    const hash = hashOf(repo);
    const other = repository();
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(other, '.devcontainer', 'Dockerfile'), past, past);
    expect(hashOf(other)).toBe(hash);
    // The files outside of the build context are not in it.
    write(path.join(other, 'src', 'index.ts'), 'export const changed = 1;\n');
    expect(hashOf(other)).toBe(hash);
    // The configuration without a context: none is hashed.
    const command = readFilesCommand(repo, '.devcontainer/devcontainer.json');
    expect(JSON.parse(spawnSync(process.execPath, command.slice(1), { encoding: 'utf8' }).stdout.trim())).not.toHaveProperty('contextHash');
  });

  it.each([
    ['the content of a file', (repo: string) => write(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), '#!/bin/sh\necho other\n')],
    ['the mode of a file', (repo: string) => fs.chmodSync(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), 0o644)],
    ['the mode of a folder', (repo: string) => fs.chmodSync(path.join(repo, '.devcontainer', 'scripts'), 0o700)],
    ['the name of a file', (repo: string) => fs.renameSync(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), path.join(repo, '.devcontainer', 'scripts', 'setup2.sh'))],
    ['the target of a link', (repo: string) => (fs.unlinkSync(path.join(repo, '.devcontainer', 'setup')), fs.symlinkSync('scripts/other.sh', path.join(repo, '.devcontainer', 'setup')))],
    ['a new empty file', (repo: string) => write(path.join(repo, '.devcontainer', 'empty'), '')],
    ['a new empty folder', (repo: string) => fs.mkdirSync(path.join(repo, '.devcontainer', 'folder'))],
    ['the .dockerignore', (repo: string) => write(path.join(repo, '.devcontainer', '.dockerignore'), '')],
  ])('gives another hash after a change of %s', (_name, change) => {
    const repo = repository();
    const hash = hashOf(repo);
    change(repo);
    expect(hashOf(repo)).not.toBe(hash);
  });

  it('hashes the whole repository for the context `.`, with the Dockerfile in it', () => {
    const repo = repository();
    const hash = hashOf(repo, '.');
    expect(hash).not.toBe(hashOf(repo));
    write(path.join(repo, 'src', 'index.ts'), 'export const changed = 1;\n');
    expect(hashOf(repo, '.')).not.toBe(hash);
  });

  it.each([
    ['a Dockerfile outside of the build context', (repo: string) => fs.mkdirSync(path.join(repo, 'src', 'app')), 'src', 'its Dockerfile ../.devcontainer/Dockerfile is no plain file in it'],
    ['a Dockerfile that is a link in the build context', (repo: string) => (fs.renameSync(path.join(repo, '.devcontainer', 'Dockerfile'), path.join(repo, '.devcontainer', 'real')), fs.symlinkSync('real', path.join(repo, '.devcontainer', 'Dockerfile'))), '.devcontainer', 'its Dockerfile Dockerfile is no plain file in it'],
    ['a FIFO', (repo: string) => expect(spawnSync('mkfifo', [path.join(repo, '.devcontainer', 'fifo')]).status).toBe(0), '.devcontainer', 'the entry fifo is no file, folder or link'],
    ['a file with the setuid bit', (repo: string) => fs.chmodSync(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), 0o4755), '.devcontainer', 'the entry scripts/setup.sh has the setuid or setgid bit'],
    ['a build context that is a link out of the repository', (repo: string) => fs.symlinkSync(path.dirname(repo), path.join(repo, 'out')), 'out', 'its real folder is not in the repository'],
    // The text that was read (decoded as UTF-8) is not the content in the hash.
    ['a Dockerfile that is no UTF-8 text', (repo: string) => fs.writeFileSync(path.join(repo, '.devcontainer', 'Dockerfile'), Buffer.from('FROM node:24\n# \xff\n', 'latin1')), '.devcontainer', 'its Dockerfile is not the text that was read (it changed, or it is no UTF-8 text)'],
  ])('gives no hash for %s, and says why', (_name, change, context, reason) => {
    const repo = repository();
    change(repo);
    const value = read(repo, context);
    expect(value).not.toHaveProperty('contextHash');
    // The Dockerfile that is a link is not read at all: no text, no hash.
    if (value.dockerfileText !== undefined) expect(value.contextUnhashable).toBe(reason);
  });

  it(`gives no hash for a build context with more than ${MAX_CONTEXT_ENTRIES} entries`, () => {
    const repo = repository();
    const many = path.join(repo, '.devcontainer', 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < MAX_CONTEXT_ENTRIES; i += 1) fs.writeFileSync(path.join(many, String(i)), '');
    expect(read(repo).contextUnhashable).toBe(`it has more than ${MAX_CONTEXT_ENTRIES} files, folders and links`);
  });

  it('gives the hash of the build context only with the Dockerfile that was read', () => {
    const repo = repository();
    fs.rmSync(path.join(repo, '.devcontainer', 'Dockerfile'));
    const value = read(repo);
    expect(value.dockerfileMissing).toBe(true);
    expect(value).not.toHaveProperty('contextHash');
    expect(value).not.toHaveProperty('contextUnhashable');
  });
});

describe('WRITE_AND_RUN_SCRIPT: the checked copy of the build context', () => {
  /** A fake `devcontainer` that prints its arguments, one per line. */
  function setup(): { folder: string; env: NodeJS.ProcessEnv } {
    const dir = tempDir();
    write(path.join(dir, 'bin', 'devcontainer'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
    fs.chmodSync(path.join(dir, 'bin', 'devcontainer'), 0o755);
    return { folder: path.join(dir, 'override'), env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` } };
  }

  function build(repo: string, folder: string, env: NodeJS.ProcessEnv, context: unknown, own = `${folder}/devcontainer.json`) {
    const repositoryConfig = path.join(repo, '.devcontainer', 'devcontainer.json');
    const result = spawnSync(process.execPath, ['-e', WRITE_AND_RUN_SCRIPT, folder, repositoryConfig, own, 'build', '--workspace-folder', repo], {
      encoding: 'utf8',
      input: JSON.stringify({ files: { [`${folder}/devcontainer.json`]: '{}' }, lockfile: null, context }),
      env,
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('copies the build context with its modes and links, and runs the CLI when the copy has the hash of the key', () => {
    const repo = repository();
    const hash = hashOf(repo);
    const { folder, env } = setup();
    const result = build(repo, folder, env, { path: '.devcontainer', hash, dockerfile: 'Dockerfile' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('build\n');
    const copy = path.join(folder, CONTEXT_COPY_FOLDER);
    expect(fs.readFileSync(path.join(copy, 'Dockerfile'), 'utf8')).toBe(DOCKERFILE);
    expect(fs.statSync(path.join(copy, 'scripts', 'setup.sh')).mode & 0o7777).toBe(0o755);
    expect(fs.readlinkSync(path.join(copy, 'setup'))).toBe('scripts/setup.sh');
    expect(fs.readdirSync(copy).sort()).toEqual(fs.readdirSync(path.join(repo, '.devcontainer')).sort());
    // The times of a file stay (as a COPY of the build context would give them without our copy).
    expect(Math.abs(fs.statSync(path.join(copy, 'Dockerfile')).mtimeMs - fs.statSync(path.join(repo, '.devcontainer', 'Dockerfile')).mtimeMs)).toBeLessThan(2);
    // The copy has the hash of the key too: the same files, folders and links, with the same modes.
    const command = readFilesCommand(copy, 'devcontainer.json', undefined, '.');
    const again = JSON.parse(spawnSync(process.execPath, command.slice(1), { encoding: 'utf8' }).stdout.trim()) as Record<string, unknown>;
    expect(again.contextHash).toBe(hash);
  });

  it('fails as a changed lockfile does, before the CLI starts, when the build context changed after its hash was read', () => {
    const repo = repository();
    const hash = hashOf(repo);
    write(path.join(repo, '.devcontainer', 'scripts', 'setup.sh'), '#!/bin/sh\necho changed\n');
    const { folder, env } = setup();
    const result = build(repo, folder, env, { path: '.devcontainer', hash, dockerfile: 'Dockerfile' });
    expect(result.status).toBe(LOCKFILE_CHANGED_EXIT);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`The build context .devcontainer ${LOCKFILE_CHANGED_TEXT}`);
    // One that cannot be hashed any more (here: its Dockerfile is gone) too, with the reason.
    fs.rmSync(path.join(repo, '.devcontainer', 'Dockerfile'));
    const gone = build(repo, setup().folder, env, { path: '.devcontainer', hash, dockerfile: 'Dockerfile' });
    expect(gone.status).toBe(LOCKFILE_CHANGED_EXIT);
    expect(gone.stderr).toContain(`The build context .devcontainer ${LOCKFILE_CHANGED_TEXT} (its Dockerfile Dockerfile is no plain file in it)`);
  });

  it('refuses a build context without our copy of the configuration, outside of the repository, or of another form', () => {
    const repo = repository();
    const hash = hashOf(repo);
    const { folder, env } = setup();
    for (const [context, own] of [
      [{ path: '.devcontainer', hash, dockerfile: 'Dockerfile' }, ''],
      [{ path: '..', hash, dockerfile: 'repo/.devcontainer/Dockerfile' }, undefined],
      [{ path: '.devcontainer', hash }, undefined],
      ['.devcontainer', undefined],
    ] as const) {
      const result = build(repo, folder, env, context, own);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Invalid build context/);
    }
  });
});
