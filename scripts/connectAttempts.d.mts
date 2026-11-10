// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

/** The longest time of one connection attempt to one address, in milliseconds. */
export const CONNECT_ATTEMPT_MS: number;

/** Gives each connection attempt of this process to one address CONNECT_ATTEMPT_MS instead of 250 ms. */
export function allowSlowConnects(): void;
