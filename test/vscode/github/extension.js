// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The sign-in provider `github` of the attach tests, in place of the built-in one (VS Code starts with
// --disable-extension vscode.github-authentication). Every request gets a session of the test account of the Docker
// tests (test/docker/harness.ts TEST_ACCOUNT), or of the account DEVSPACE_TEST_GITHUB_ACCOUNT, with a dummy token, for
// exactly the scopes that it asks for, without a dialog. GitHub rejects the token, so every question to GitHub fails.
// Each answer has a new session ID. The extension asks for a new sign-in (forceNewSession, a dialog that VS Code
// refuses in tests) only while the session whose token GitHub rejected is still the current one (src/vscode/auth.ts,
// isRejected); with a new ID the open of the window does not depend on whether a 401 arrives before it asks.
// With DEVSPACE_TEST_GITHUB_SIGNED_OUT=1 (the README GIF, test/gif/record.mjs), VS Code starts without a session, as
// before the first sign-in: the provider gives sessions only after the first createSession (Sign in with GitHub).
const vscode = require('vscode');

/** The account: the test account of the Docker tests, or DEVSPACE_TEST_GITHUB_ACCOUNT (JSON with id and label). */
const ACCOUNT = process.env.DEVSPACE_TEST_GITHUB_ACCOUNT ? JSON.parse(process.env.DEVSPACE_TEST_GITHUB_ACCOUNT) : { id: '4242', label: 'devspaces-test' };
const TOKEN = 'dummy-token-of-the-vscode-attach-tests';
let sessions = 0;
let signedIn = process.env.DEVSPACE_TEST_GITHUB_SIGNED_OUT !== '1';

function session(scopes) {
  sessions += 1;
  return { id: `test-${sessions}`, accessToken: TOKEN, account: ACCOUNT, scopes: [...scopes] };
}

exports.activate = (context) => {
  const changes = new vscode.EventEmitter();
  context.subscriptions.push(
    changes,
    vscode.authentication.registerAuthenticationProvider(
      'github',
      'GitHub',
      {
        onDidChangeSessions: changes.event,
        getSessions: async (scopes) => (signedIn ? [session(scopes ?? [])] : []),
        createSession: async (scopes) => {
          const created = session(scopes);
          if (!signedIn) {
            signedIn = true;
            changes.fire({ added: [created], removed: [], changed: [] });
          }
          return created;
        },
        removeSession: async () => {},
      },
      { supportsMultipleAccounts: false },
    ),
  );
};
