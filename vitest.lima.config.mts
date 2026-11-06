// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { defineConfig } from 'vitest/config';
import { buildDefines } from './scripts/buildDefines.mjs';

// The test of the Lima VM of Devspaces with the real Lima of the pin, on a Linux with KVM and QEMU, with the disk of a
// build of the image (DEVSPACES_LIMA_TEST_DISK): the job "lima test" of .github/workflows/vm-image.yml. `npm test` does
// not run it.
export default defineConfig({
  // The same compile-time constants as in esbuild.mjs (src/types/globals.d.ts).
  define: buildDefines(),
  test: {
    include: ['test/lima/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    // The first start of the VM runs cloud-init, and the idle check stops it after two quiet minutes.
    testTimeout: 20 * 60_000,
    hookTimeout: 5 * 60_000,
    reporters: ['verbose'],
  },
});
