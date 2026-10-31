// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Probes for mutants of the protocol parsers (protocol.ts).
import { describe, expect, it } from 'vitest';
import { parseProbeValue, sameEngine } from './protocol';

describe('sameEngine and parseProbeValue', () => {
  // Kills the mutant that compares the IDs case-insensitively (or after any normalization): the values are compared
  // exactly, as the engines name them.
  it('sameEngine compares the ID and the root folder exactly', () => {
    expect(sameEngine({ id: 'abcd:efgh', rootDir: '/var/lib/docker' }, { id: 'ABCD:EFGH', rootDir: '/var/lib/docker' })).toBe(false);
    expect(sameEngine({ id: 'id', rootDir: '/var/lib/docker' }, { id: 'id', rootDir: '/var/lib/docker/' })).toBe(false);
    expect(sameEngine({ id: 'id', rootDir: '/var/lib/docker' }, { id: 'id', rootDir: '/var/lib/docker' })).toBe(true);
  });

  // Kills the mutant that drops the type check of serverVersion (the line is older than the PR; the worker is untrusted,
  // so a version that is no string is an invalid answer).
  it('parseProbeValue refuses a server version that is no string', () => {
    for (const serverVersion of [27, null, { v: '27' }, ['27']]) {
      expect(parseProbeValue({ serverVersion, detail: 'd', engine: { id: 'id', rootDir: '/r' } }), JSON.stringify(serverVersion)).toBeUndefined();
    }
  });

  // The API versions go into the check of the Docker CLI of Devspaces and into its message: only the form `1.40`.
  it('parseProbeValue takes API versions of the form 1.40 only', () => {
    const value = { serverVersion: '29.1.0', apiVersion: '1.52', minApiVersion: '1.44', detail: 'd' };
    expect(parseProbeValue(value)).toEqual(value);
    expect(parseProbeValue({ serverVersion: '29.1.0', detail: 'd' })).toStrictEqual({ serverVersion: '29.1.0', detail: 'd' });
    for (const odd of [1.52, null, '', '1', 'v1.52', '1.52.0', '1.52\n', '12345.1', ['1.52']]) {
      expect(parseProbeValue({ ...value, apiVersion: odd }), JSON.stringify(odd)).toBeUndefined();
      expect(parseProbeValue({ ...value, minApiVersion: odd }), JSON.stringify(odd)).toBeUndefined();
    }
  });
});
