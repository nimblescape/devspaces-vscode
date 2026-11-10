// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { CommandError, UserFacingError } from '../core/errors';
import { OUTPUT_CHANNEL_NAME, OutputChannelLogger, redactSecrets, stripControlSequences } from './logger';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('OutputChannelLogger', () => {
  beforeEach(() => resetFakeVscode());

  it('writes timestamped lines to the output channel "Devspaces"', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    expect(channel.name).toBe(OUTPUT_CHANNEL_NAME);
    expect(OUTPUT_CHANNEL_NAME).toBe('Devspaces');
    logger.info('Step: Starting devspace');
    logger.warn('careful');
    expect(channel.text).toMatch(/^\[\d\d:\d\d:\d\d\] info Step: Starting devspace\n\[\d\d:\d\d:\d\d\] warn careful\n$/);
  });

  it('is the name that the messages give the output: "see the Devspaces output"', () => {
    const root = path.join(__dirname, '..');
    const names = fs
      .readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) => [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/see the (\S+) output/gi)].map((match) => `${file}: ${match[1]}`));
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((name) => !name.endsWith(`: ${OUTPUT_CHANNEL_NAME}`))).toEqual([]);
  });

  it('appends tool output as it is, and starts a log line on a new line', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output('Step 1/3 : FROM ubuntu');
    logger.info('next');
    logger.output('done\n');
    logger.info('after');
    expect(channel.text).toMatch(/^Step 1\/3 : FROM ubuntu\n\[[\d:]+\] info next\ndone\n\[[\d:]+\] info after\n$/);
  });

  it('writes tool output without the color codes of a terminal, also when a code is cut between two parts', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    // The classic builder of Docker marks the error output of a RUN step red.
    logger.output('\u001b[91m+ docker compose version\n\u001b[0mDocker Compose version v5.7.0\n\u001b[9');
    logger.output('1m+ apt-get clean\n\u001b[');
    logger.output('0m');
    logger.output('\u001b]0;title\u0007done\n');
    expect(channel.text).toBe('+ docker compose version\nDocker Compose version v5.7.0\n+ apt-get clean\ndone\n');
  });

  it('keeps a cut color code for the next output also when a log line comes between, and strips the codes of log lines', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output('red\n\u001b[9');
    logger.error('failed', new CommandError('docker build', 1, '', '\u001b[91mE: Unable to locate package\u001b[0m'));
    logger.output('1mnext\n');
    expect(channel.text).toMatch(/^red\n\[[\d:]+\] error failed\ndocker build failed with exit code 1:\nE: Unable to locate package\nnext\n$/);
  });

  it('drops a lone ESC at the end of an output, so that it never takes the first character of the next one', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output('stopped\n\u001b');
    logger.output('Building image\n');
    expect(channel.text).toBe('stopped\nBuilding image\n');
  });

  it('drops a cut sequence whose rest did not come within a second: the next output is another one', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      logger.output('stopped\n\u001b[');
      now.mockReturnValue(1_002_000);
      logger.output('Step 1/5\n');
    } finally {
      now.mockRestore();
    }
    expect(channel.text).toBe('stopped\nStep 1/5\n');
  });

  it('holds a cut OSC sequence and a cut sequence of ESC and intermediate characters too', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output('a\u001b]0;building');
    logger.output(' image\u0007b\u001b(');
    logger.output('Bc\n');
    expect(channel.text).toBe('abc\n');
  });

  it('strips CSI, OSC and two-character sequences, and leaves other text as it is', () => {
    expect(stripControlSequences('a\u001b[1;31mb\u001b[0mc')).toBe('abc');
    expect(stripControlSequences('a\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\b')).toBe('alinkb');
    expect(stripControlSequences('a\u001b(Bb\u001bMc')).toBe('abc');
    expect(stripControlSequences('a\u001b7b\u001b8c\u001b=d\u001b>e\u001bcf')).toBe('abcdef');
    expect(stripControlSequences('Step 1/13 : FROM node [ok]')).toBe('Step 1/13 : FROM node [ok]');
  });

  it('logs the technical details of an error', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.error('The devspace could not be prepared.', new UserFacingError('buildFailed', 'The devspace could not be prepared.', 'exit 1'));
    logger.error('failed', new CommandError('docker build', 1, '', 'no space left on device'));
    expect(channel.text).toContain('error The devspace could not be prepared.\nexit 1\n');
    expect(channel.text).toContain('error failed\ndocker build failed with exit code 1:\nno space left on device\n');
  });

  it('never writes a GitHub token', () => {
    const token = `gho_${'a1B2'.repeat(9)}`;
    const pat = `github_pat_${'x'.repeat(30)}`;
    expect(redactSecrets(`Authorization: bearer ${token} and ${pat}`)).toBe('Authorization: bearer *** and ***');
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output(`remote: ${token}\n`);
    logger.info(`token ${token}`);
    expect(channel.text).not.toContain(token);
  });

  it('shows the channel for Show details and stops writing after dispose', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.show();
    expect(channel.shown).toBe(1);
    logger.dispose();
    logger.info('late');
    logger.show();
    expect(channel.disposed).toBe(true);
    expect(channel.text).toBe('');
    expect(channel.shown).toBe(1);
  });
});
