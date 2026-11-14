// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The section "Layers" of the report of an image (R-ENG-010): the steps of `docker image history`, the first one first,
// and never a value of a build argument, of ENV or of ARG.
import { describe, expect, it } from 'vitest';
import { isShellCall } from '../docker/bootstrapDocker';
import { MAX_LAYERS, MAX_STEP_LENGTH, imageHistoryArgs, layersSection, parseImageHistory, stepText, type ImageLayer } from './imageHistory';
import type { ReportClock } from './reportModel';

const CLOCK: ReportClock = { now: Date.parse('2026-11-14T07:00:00Z'), timeZone: 'Europe/Vienna' };

describe('the history of an image', () => {
  it('reads with a call that the shell of a host carries, and parses each step', () => {
    expect(isShellCall(imageHistoryArgs('sha256:abc'))).toBe(true);
    const stdout = [
      JSON.stringify({ CreatedAt: '2026-11-01T10:00:00+01:00', CreatedBy: 'RUN /bin/sh -c apt-get update # buildkit', Size: '1234567', ID: '<missing>' }),
      'not json',
      JSON.stringify({ CreatedBy: '', Size: 'x' }),
    ].join('\n');
    expect(parseImageHistory(stdout)).toEqual([
      { createdBy: 'RUN /bin/sh -c apt-get update # buildkit', size: 1234567, createdAt: '2026-11-01T10:00:00+01:00' },
      { createdBy: '', size: 0 },
    ]);
  });
});

describe('stepText', () => {
  it('shows the instruction without the shell and without the marks of the builders', () => {
    expect(stepText('RUN /bin/sh -c apt-get update && apt-get install -y git # buildkit')).toBe('RUN apt-get update && apt-get install -y git');
    expect(stepText('/bin/sh -c apt-get update')).toBe('RUN apt-get update');
    expect(stepText('/bin/sh -c #(nop)  CMD ["bash"]')).toBe('CMD ["bash"]');
    expect(stepText('/bin/sh -c #(nop) ADD file:0123 in / ')).toBe('ADD file:0123 in /');
    expect(stepText('COPY ./install.sh /tmp/ # buildkit')).toBe('COPY ./install.sh /tmp/');
    expect(stepText('WORKDIR /workspace')).toBe('WORKDIR /workspace');
    expect(stepText('')).toBe('(no step recorded)');
    expect(stepText(`RUN /bin/sh -c ${'x'.repeat(500)}`)).toHaveLength(MAX_STEP_LENGTH);
  });

  it('never shows a value of a build argument: only their names, and nothing of a command it cannot split safely', () => {
    expect(stepText('RUN |2 TOKEN=ghp_secret VERSION=1.2 /bin/sh -c ./install.sh # buildkit')).toBe('RUN ./install.sh (build arguments TOKEN, VERSION)');
    expect(stepText('|1 PASSWORD=hunter2 /bin/sh -c make')).toBe('RUN make (build argument PASSWORD)');
    // A value with a space shifts the words: the command is not shown.
    const spaced = stepText('RUN |1 PASSWORD=two words /bin/sh -c make # buildkit');
    expect(spaced).toBe('RUN (a command with 1 build argument; not shown, because a value could be a secret)');
    // The exec form has no shell after the build arguments: not shown either.
    expect(stepText('RUN |1 TOKEN=abc ./run.sh # buildkit')).toBe('RUN (a command with 1 build argument; not shown, because a value could be a secret)');
    for (const text of [stepText('RUN |2 TOKEN=ghp_secret VERSION=1.2 /bin/sh -c ./install.sh'), spaced]) expect(text).not.toMatch(/ghp_secret|hunter2|two words/);
  });

  it('never shows a value of ENV or ARG, only the names', () => {
    expect(stepText('ENV API_TOKEN=ghp_secret PATH=/usr/local/bin:/usr/bin # buildkit')).toBe('ENV API_TOKEN, PATH (the values are not shown)');
    expect(stepText('/bin/sh -c #(nop)  ENV TOKEN=abc')).toBe('ENV TOKEN (the value is not shown)');
    expect(stepText('/bin/sh -c #(nop)  ENV TOKEN abc def')).toBe('ENV TOKEN (the value is not shown)');
    expect(stepText('ARG TOKEN=default-secret')).toBe('ARG TOKEN (the value is not shown)');
    expect(stepText('ARG VARIANT')).toBe('ARG VARIANT');
    expect(stepText('ENV "x y"')).toBe('ENV (not shown, because a value could be a secret)');
  });
});

describe('layersSection', () => {
  it('lists the steps the first one first, with what each added and when', () => {
    const layers: ImageLayer[] = [
      { createdBy: 'CMD ["bash"] # buildkit', size: 0, createdAt: '2026-11-13T10:00:00Z' },
      { createdBy: 'RUN /bin/sh -c apt-get update # buildkit', size: 25_000_000, createdAt: '2026-11-13T09:59:00Z' },
      { createdBy: '/bin/sh -c #(nop) ADD file:0123 in / ', size: 80_000_000 },
    ];
    const section = layersSection(layers, CLOCK);
    expect(section.title).toBe('Layers');
    expect(section.body).toEqual({
      kind: 'table',
      columns: ['Step', 'Added', 'Created'],
      rows: [
        [{ text: 'ADD file:0123 in /' }, { text: '80 MB' }, { text: '' }],
        [{ text: 'RUN apt-get update' }, { text: '25 MB' }, { text: 'yesterday 10:59' }],
        [{ text: 'CMD ["bash"]' }, { text: '0 B' }, { text: 'yesterday 11:00' }],
      ],
      empty: 'Docker gives no steps for this image.',
    });
    expect(section.from).toContain('3 steps, 105 MB in all');
  });

  it('shows at most MAX_LAYERS steps, the newest ones, and says how many are left out', () => {
    const layers = Array.from({ length: MAX_LAYERS + 5 }, (_, i) => ({ createdBy: `RUN /bin/sh -c step ${MAX_LAYERS + 5 - i}`, size: 1 }));
    const body = layersSection(layers, CLOCK).body;
    if (body.kind !== 'table') throw new Error('no table');
    expect(body.rows).toHaveLength(MAX_LAYERS);
    expect(body.rows[0][0].text).toBe('RUN step 6');
    expect(body.rows.at(-1)?.[0].text).toBe(`RUN step ${MAX_LAYERS + 5}`);
    expect(body.more).toBe('The 5 earliest steps are left out.');
  });
});
