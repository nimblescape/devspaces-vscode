// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Node.js connects to a host with several addresses one address after the other (autoSelectFamily, "Happy Eyeballs"):
// it gives each address at most 250 ms by default, closes that connection attempt, and fails with ETIMEDOUT when the
// last address fails too. The runners of GitHub Actions reach no IPv6 address (ENETUNREACH at once), so an IPv4
// connection that takes longer than 250 ms, for example after one lost SYN packet (TCP sends it again after 1 s),
// fails the whole download: the attach preparation of CI failed twice so at "Resolving version" of VS Code
// (update.code.visualstudio.com, runs 42235034672 and 42805047747). The programs of the tests that download VS Code
// call allowSlowConnects first: .vscode-test.mjs (@vscode/test-cli downloads VS Code in its process),
// test/vscode/attach/prepare.ts and scripts/install-attach-extensions.mjs. The module uses no import.meta, because
// scripts/build-vscode-tests.mjs bundles prepare.ts as CommonJS.
import * as net from 'net';

/**
 * The longest time of one connection attempt to one address. Linux sends a SYN packet that got no answer again 1 s,
 * 3 s and 7 s after the first one; 10 s waits for all three repetitions.
 */
export const CONNECT_ATTEMPT_MS = 10_000;

/** Gives each connection attempt of this process to one address CONNECT_ATTEMPT_MS instead of 250 ms. */
export function allowSlowConnects() {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
}
