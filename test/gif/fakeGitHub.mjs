// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The GitHub GraphQL API of the README GIF (record.mjs): an HTTPS server for api.github.com that answers the queries of
// src/core/discovery/discoveryService.ts with a fixed demo account and its repositories, so that the view lists them
// without a real GitHub account. The test sign-in provider (test/vscode/github) gives a dummy token, which GitHub
// itself rejects. record.mjs points api.github.com to this server in /etc/hosts and adds its certificate authority to
// the certificates of the system, which the extension host of VS Code trusts. The extension is not changed.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';

/**
 * A certificate authority and a certificate of api.github.com that it signed, in `folder` (made with openssl). Returns
 * the files: `ca` for the certificates of the system, `key` and `cert` for the server.
 */
export function makeCertificates(folder) {
  fs.mkdirSync(folder, { recursive: true });
  const file = (name) => path.join(folder, name);
  const openssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Devspaces README GIF CA', '-keyout', file('ca.key'), '-out', file('ca.crt'));
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.github.com', '-keyout', file('server.key'), '-out', file('server.csr'));
  fs.writeFileSync(file('server.ext'), 'subjectAltName=DNS:api.github.com\nextendedKeyUsage=serverAuth\n');
  openssl('x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial', '-days', '2', '-extfile', file('server.ext'), '-out', file('server.crt'));
  return { ca: file('ca.crt'), key: file('server.key'), cert: file('server.crt') };
}

/** The repository node of RepositoryListFields and RepositoryFields (discoveryService.ts). */
function repositoryNode(repository, index) {
  const [owner, name] = repository.nameWithOwner.split('/');
  return {
    id: `R_demo${index}`,
    name,
    nameWithOwner: repository.nameWithOwner,
    url: `https://github.com/${repository.nameWithOwner}`,
    isArchived: false,
    isFork: false,
    isPrivate: repository.isPrivate ?? true,
    // The newest push first: the order of the list.
    pushedAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
    viewerPermission: repository.permission ?? 'WRITE',
    owner: { login: owner },
    defaultBranchRef: { name: 'main' },
  };
}

/** The configuration lookups of one repository: `.devcontainer/devcontainer.json` (detect.ts). */
const CONFIGURATION = { rootFile: null, folder: { entries: [{ name: 'devcontainer.json', type: 'blob', object: null }] } };
const PAGE = { hasNextPage: false, endCursor: null };

/**
 * The answer to one GraphQL request, by the name of its operation. `demo`: `{ account: { id, login, name },
 * organizations: [login], repositories: [{ nameWithOwner, permission, isPrivate }] }`.
 */
export function answer(body, demo) {
  const operation = /^\s*query\s+(\w+)/.exec(body.query ?? '')?.[1];
  const variables = body.variables ?? {};
  const viewer = { login: demo.account.login, databaseId: Number(demo.account.id) };
  const organizations = { pageInfo: PAGE, nodes: demo.organizations.map((login) => ({ login })) };
  const nodes = demo.repositories.map(repositoryNode);
  const find = (owner, name) => nodes.find((node) => node.nameWithOwner.toLowerCase() === `${owner}/${name}`.toLowerCase());
  switch (operation) {
    case 'Viewer':
      return { data: { viewer: { ...viewer, name: demo.account.name } } };
    case 'ScopeViewer':
      return { data: { viewer: { ...viewer, organizations } } };
    case 'Organizations':
      return { data: { viewer: { organizations } } };
    case 'Discover':
      return { data: { viewer: { ...viewer, ...(variables.withOrganizations ? { organizations } : {}), repositories: { pageInfo: PAGE, nodes } } } };
    case 'ViewerRepositories':
      return { data: { viewer: { login: viewer.login, repositories: { pageInfo: PAGE, nodes: nodes.filter((node) => node.owner.login === viewer.login) } } } };
    case 'OwnerRepositories': {
      const owned = nodes.filter((node) => node.owner.login.toLowerCase() === String(variables.login).toLowerCase());
      if (owned.length === 0) return { data: { repositoryOwner: null } };
      const type = demo.organizations.includes(owned[0].owner.login) ? 'Organization' : 'User';
      return { data: { repositoryOwner: { __typename: type, login: owned[0].owner.login, repositories: { pageInfo: PAGE, nodes: owned } } } };
    }
    case 'Configurations': {
      const data = {};
      for (let i = 0; `o${i}` in variables; i++) data[`r${i}`] = find(variables[`o${i}`], variables[`n${i}`]) ? CONFIGURATION : null;
      return { data };
    }
    case 'OrganizationAccess': {
      const data = {};
      for (let i = 0; `o${i}` in variables; i++) data[`o${i}`] = { login: variables[`o${i}`], repositories: { nodes: [{ id: 'R_access' }] } };
      return { data };
    }
    case 'Repository': {
      const node = find(variables.owner, variables.name);
      return { data: { repository: node ? { ...node, ...CONFIGURATION } : null } };
    }
    case 'BranchConfigurations':
      return { data: { repository: find(variables.owner, variables.name) ? CONFIGURATION : null } };
    default:
      return { errors: [{ message: `The fake GitHub API of the README GIF has no answer to the operation ${operation ?? '(none)'}.` }] };
  }
}

/** Starts the server on `port` of 127.0.0.1 and returns it. Each request and its operation go to `log`. */
export function startFakeGitHub({ port, key, cert, demo, log }) {
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(text || '{}');
      } catch {
        // An answer with an error follows.
      }
      const result = request.method === 'POST' && request.url === '/graphql' ? answer(body, demo) : { errors: [{ message: `No answer to ${request.method} ${request.url}.` }] };
      log(`${request.method} ${request.url} ${/^\s*query\s+(\w+)/.exec(body.query ?? '')?.[1] ?? ''}${result.errors ? ` -> ${result.errors[0].message}` : ''}`);
      const json = JSON.stringify(result);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'x-ratelimit-remaining': '4999' });
      response.end(json);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
