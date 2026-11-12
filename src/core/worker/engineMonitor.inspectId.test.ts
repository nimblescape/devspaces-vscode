// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The ID of an inspect is 64 lower-case hex digits, the ID of its image is a full image ID, and an inspect answer that is null is a failure, never evidence
// that the container is missing.
import { describe, expect, it } from 'vitest';
import { unusedEngine } from './dockerEngine.testkit';
import { engineMonitor, monitorInspected } from './engineMonitor';

describe('engineMonitor: the IDs of an inspect and a null answer', () => {
  it('reads only an ID of 64 lower-case hex digits', () => {
    expect(monitorInspected({ Id: 'a'.repeat(64) })).toMatchObject({ id: 'a'.repeat(64) });
    expect(monitorInspected({ Id: 'A'.repeat(64) })).toMatchObject({ id: undefined });
    expect(monitorInspected({ Id: 'a'.repeat(12) })).toMatchObject({ id: undefined });
  });

  it('reads the ID of its image: sha256 and 64 lower-case hex digits', () => {
    const image = `sha256:${'b'.repeat(64)}`;
    expect(monitorInspected({ Image: image })).toMatchObject({ image });
    for (const odd of ['b'.repeat(64), `sha256:${'B'.repeat(64)}`, 'devspaces-monitor:0123456789ab', 7]) expect(monitorInspected({ Image: odd })).not.toHaveProperty('image');
  });

  it('reads the version of Devspaces of its script from its label (R-DS-011): only a version x.y.z', () => {
    expect(monitorInspected({ Config: { Labels: { 'nimblescape.devspaces.monitor-version': '0.7.0' } } })).toMatchObject({ version: '0.7.0' });
    for (const odd of ['0.7', 'v0.7.0', 7, '']) expect(monitorInspected({ Config: { Labels: { 'nimblescape.devspaces.monitor-version': odd } } })).not.toHaveProperty('version');
    expect(monitorInspected({ Config: { Labels: {} } })).not.toHaveProperty('version');
  });

  it('an inspect answer of null fails the inspect', async () => {
    const monitor = engineMonitor({ ...unusedEngine(), inspect: async () => null });
    await expect(monitor.inspect('devspaces-monitor')).rejects.toThrow(/^docker container inspect failed: /);
  });
});
