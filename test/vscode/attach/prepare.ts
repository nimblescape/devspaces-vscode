// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Prepares the Docker engine of this computer and the test VS Code for the attach tests (configuration `attach` of
// .vscode-test.mjs), and writes what it made to out/test/vscode/attach/seed.json (npm run test:vscode:attach:prepare).
// It uses the real Docker engine, where the extension then creates its own objects (Monitor, workers, volumes) with the
// names of a real installation, so it runs only on CI, on a runner of its own.
// - The test VS Code (downloaded to .vscode-test/ as @vscode/test-cli does) trusts the Devspaces extension with the
//   sessions of the sign-in provider `github` (trustedExtensionAuthAccess in its product.json), so that the
//   extension gets the session of the fake provider (test/vscode/github) without the dialog that asks for access.
// - The workspace helper image, built as the extension builds it, so that the restore of the registry at activation
//   (passive: it builds no image) finds the devspace.
// - A devspace without container: its workspace volume with the labels of the extension (the test account owns it)
//   and a repository with a devcontainer.json. VS Code starts with a fresh user data folder, so the registry of the
//   extension is empty, and the window restores the devspace from the volume labels, as on a new computer. The
//   configuration sets the old key "remote.containers.copyGitConfig": true, a postAttachCommand that writes the time
//   of each attach, and a postStartCommand that waits LONG_START_SECONDS once when the mark LONG_START_MARK exists
//   (the run `longopen`).
// - A plain container that is no devspace, of the same dev image (with Git and the Docker CLI, so that Dev Containers
//   configures its credential helpers there).
// - The engine host: the Docker host of Devspaces in every run but `remote` (prepareEngineHost). Devspaces never uses
//   the Docker of this computer on Linux (docs/requirements.md R-ENG-001), so it reaches the engine of the runner over
//   SSH, through a container of the runner with an SSH server and the Docker socket of the runner, as it reaches a host
//   of its list. The engine stays the engine of the runner, where the CI job checks the containers with `docker`.
// With DEVSPACE_TEST_ATTACH_PREPARE=remote (the run `remote`, a CI job of its own), the devspace is on the Docker engine
// of another computer instead, reached over SSH, and the engine of the runner gets a container with its name
// (prepareRemote). That run has no plain container.
// With DEVSPACE_TEST_ATTACH_PREPARE=update (the runs `previous` and `updated`, a CI job of its own), the test VS Code
// also gets the last released version of the extension from the VSIX of its GitHub release, and the helper image is
// built as that version builds it (prepareUpdate). That run has no plain container.
// With DEVSPACE_TEST_ATTACH_PREPARE=gif (the README GIF, test/gif/record.mjs, a CI job of its own), the devspace is the
// demo repository GIF_REPOSITORY of the demo account, without container, on the engine of the runner, which the host
// GIF_HOST of the SSH config reaches (prepareGif). That run has no plain container.
// Each download from the network (VS Code, Dev Containers and the VSIX of the last release) is tried again after an
// error (withTries, NETWORK_TRIES), and the process ends as soon as the preparation is done (see the call of main).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { BootstrapDocker } from '../../../src/core/docker/bootstrapDocker';
import { findDockerCli } from '../../../src/core/docker/dockerCli';
import { sshEndpoint } from '../../../src/core/docker/dockerHost';
import { DEVCONTAINER_CLI_VERSION, helperImageTag } from '../../../src/core/helper/helperImage';
import { HelperImages } from '../../../src/core/helper/helperImages';
import { namePair } from '../../../src/core/namePairs';
import { LABEL_DEVSPACE_ID, LABEL_HELPER, LABEL_OWNER_ID, LABEL_REPOSITORY, WORKSPACES_ROOT, newDevspaceId, repositoryFolder, resourceName } from '../../../src/core/names';
import type { Logger } from '../../../src/core/ports';
import { NodeProcessRunner } from '../../../src/core/process';
import { dockerPipeAddress, dockerPipeBase, dockerPipeId } from '../../../src/core/relay/pipeAddress';
import { newComputerId } from '../../../src/core/storage/computerId';
import { folderUriParts, type WindowDocker } from '../../../src/vscode/connection/authority';
import { answerAttachQuestion } from '../../../scripts/attachQuestion.mjs';
import { allowSlowConnects } from '../../../scripts/connectAttempts.mjs';

/** The checkout: the bundle runs from out/test/vscode/attach/. */
const ROOT = path.resolve(__dirname, '../../../..');
const EXTENSION_ID = 'nimblescape.nimblescape-devspaces-2';
/** The account of the fake sign-in provider (test/vscode/github/extension.js). */
const TEST_ACCOUNT_ID = '4242';
const REPOSITORY = 'devspaces-test/attach';
/** A glibc image with a user `node`: the Dev Containers extension installs its server there. */
const BASE_IMAGE = 'mirror.gcr.io/library/node:24-trixie-slim';
/**
 * The dev image of the devspace and of the plain container: the base image with Git and the Docker CLI, so that Dev
 * Containers configures its credential helpers of Git and Docker where its settings allow them.
 */
const DOCKERFILE = `FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli git && rm -rf /var/lib/apt/lists/*
`;
const PLAIN_IMAGE = 'devspaces-attach-test-plain:1';
/**
 * The run `longopen`: a start of the devspace container that takes several minutes. The CI job writes the mark (as
 * the remote user) and stops the container; postStartCommand removes the mark, so it waits once, and writes when it
 * began and ended.
 */
const LONG_START_SECONDS = 150;
const LONG_START_MARK = '/tmp/devspaces-test-long-start';
const POST_START_COMMAND = `if [ -f ${LONG_START_MARK} ]; then rm -f ${LONG_START_MARK}; date +%s > /tmp/long-start-began; sleep ${LONG_START_SECONDS}; date +%s > /tmp/long-start-ended; fi`;

/**
 * The run `remote`: the other computer is a container of the runner with a Docker engine of its own (Docker in Docker,
 * its data in a volume of the runner, where its storage driver works) and an SSH server for root with key
 * authentication. MaxStartups, MaxSessions and PerSourcePenalties are set as in test/docker/sshd/Dockerfile, because the
 * Docker CLI opens a new SSH connection for each call (OpenSSH of docker:28-dind knows PerSourcePenalties). The host
 * REMOTE_HOST of the SSH config of the runner points to it. sshd logs each login (LogLevel VERBOSE), and its
 * ForceCommand REMOTE_HOST_SESSION writes the command of each session into the log of the container before it runs it as
 * sshd would, so that remote.test.ts can count the SSH logins of the open.
 */
const REMOTE_HOST = 'devspaces-test-remote';
const REMOTE_HOST_IMAGE = 'devspaces-attach-test-remote:2';
const REMOTE_HOST_CONTAINER = 'attach-test-remote-host';
const REMOTE_HOST_DOCKER_VOLUME = 'attach-test-remote-docker';
/** The ForceCommand of sshd on the other computer (REMOTE_HOST_START writes it). */
const REMOTE_HOST_SESSION = '/usr/local/bin/devspaces-test-session';
const REMOTE_HOST_DOCKERFILE = `FROM mirror.gcr.io/library/docker:28-dind
RUN apk add --no-cache openssh-server \\
 && ssh-keygen -A \\
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow \\
 && printf '%s\\n' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PubkeyAuthentication yes' 'LogLevel VERBOSE' 'MaxStartups 100:30:200' 'MaxSessions 100' 'ForceCommand ${REMOTE_HOST_SESSION}' >> /etc/ssh/sshd_config \\
 && if /usr/sbin/sshd -t -o PerSourcePenalties=no; then echo 'PerSourcePenalties no' >> /etc/ssh/sshd_config; fi \\
 && /usr/sbin/sshd -t
`;
/**
 * The start of the SSH server of a container of REMOTE_HOST_IMAGE: the public key of the runner for root and the
 * ForceCommand REMOTE_HOST_SESSION. REMOTE_HOST_SESSION writes `devspaces-test-ssh: <command>` (`(shell)` for a session
 * without a command) to the standard error of the first process of the container, which `docker logs --timestamps`
 * shows with its time, and then runs the command with `sh -c`, as sshd runs it with the shell of root.
 */
const SSH_HOST_SETUP = `set -eu
mkdir -p /root/.ssh
printf '%s\\n' "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
cat > ${REMOTE_HOST_SESSION} <<'SESSION'
#!/bin/sh
printf 'devspaces-test-ssh: %s\\n' "\${SSH_ORIGINAL_COMMAND:-(shell)}" >> /proc/1/fd/2 2>/dev/null || true
if [ -n "\${SSH_ORIGINAL_COMMAND:-}" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; fi
exec /bin/sh -l
SESSION
chmod 755 ${REMOTE_HOST_SESSION}
`;
/** The start of the other computer: its SSH server, and its Docker engine (unix socket only). */
const REMOTE_HOST_START = `${SSH_HOST_SETUP}/usr/sbin/sshd -D -e &
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock
`;
/**
 * The engine host of the runs on the engine of the runner (prepareEngineHost): a container of REMOTE_HOST_IMAGE with
 * only its SSH server, whose Docker CLI reaches the engine of the runner through its Docker socket, mounted at the
 * default path. The host ENGINE_HOST of the SSH config of the runner points to it.
 */
const ENGINE_HOST = 'devspaces-test-engine';
const ENGINE_HOST_CONTAINER = 'attach-test-engine-host';
const ENGINE_HOST_START = `${SSH_HOST_SETUP}exec /usr/sbin/sshd -D -e
`;
/** The run `gif`: the engine host and its container (prepareGif), and the demo repository of the GIF. */
const GIF_HOST = 'school-server';
const GIF_HOST_CONTAINER = 'school-server-ssh';
const GIF_REPOSITORY = 'school/web-basics';
/** The longest name pair of the devspace of the GIF (`<adjective>-<scientist>`), so that the view shows its names whole. */
const GIF_NAME_PAIR_LENGTH = 10;
/**
 * The image of the devspace of the GIF, built once before the GIF and removed again: its layers stay in the build cache
 * of the engine, so that the build at the start takes seconds, and the view Docker Hosts does not list it.
 */
const GIF_WARM_IMAGE = 'devspaces-gif-warm:1';
/** The name of the image of the engine host in the GIF (REMOTE_HOST_IMAGE gets it), as an image of the school server. */
const GIF_HOST_IMAGE = 'school-server-ssh:1';
/** The repository of the GIF: a small web page with a devcontainer.json that names two extensions. */
const GIF_FILES: Record<string, string> = {
  '.devcontainer/devcontainer.json': `${JSON.stringify(
    {
      name: 'Web basics',
      build: { dockerfile: 'Dockerfile' },
      remoteUser: 'node',
      customizations: { vscode: { extensions: ['esbenp.prettier-vscode', 'dbaeumer.vscode-eslint'] } },
    },
    null,
    2,
  )}\n`,
  '.devcontainer/Dockerfile': DOCKERFILE,
  'README.md': '# Web basics\n\nThe exercises of the course Web basics.\n',
  'index.html': '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <title>Web basics</title>\n    <link rel="stylesheet" href="style.css">\n  </head>\n  <body>\n    <h1>Hello, web!</h1>\n  </body>\n</html>\n',
  'style.css': 'body {\n  font-family: sans-serif;\n  margin: 2rem;\n}\n',
};
/** The longest wait for the Docker engine of the other computer to answer over SSH. */
const REMOTE_ENGINE_WAIT_MS = 120_000;
/**
 * The tries of each download from the network, and the wait before the second try (twice as long before the third).
 * A download failed once in a while on CI and failed the whole job: GitHub answered 504 for the VSIX of the last
 * release (run 42581587847), and the version check of @vscode/test-electron, which it does not try again, failed to
 * connect (runs 42235034672 and 42805047747, see scripts/connectAttempts.mjs).
 */
const NETWORK_TRIES = 3;
const NETWORK_RETRY_WAIT_MS = 10_000;

const log: Logger = {
  info: (message) => console.log(`INFO  ${message}`),
  warn: (message) => console.log(`WARN  ${message}`),
  error: (message, error) => console.log(`ERROR ${message}${error === undefined ? '' : `: ${String(error)}`}`),
  output: (text) => process.stdout.write(text),
};

/**
 * The result of `run`, which tries again after an error, NETWORK_TRIES times in all, with a growing wait between the
 * tries. `run` learns whether its try is the last one, so that it can return a failed answer there instead of an
 * error. `what` names the download in the log.
 */
async function withTries<T>(what: string, run: (lastTry: boolean) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt === NETWORK_TRIES);
    } catch (error) {
      if (attempt >= NETWORK_TRIES) throw error;
      const waitMs = NETWORK_RETRY_WAIT_MS * attempt;
      log.warn(`${what} failed (try ${attempt} of ${NETWORK_TRIES}), the next try in ${waitMs / 1000} s: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * The answer of a GET of `url` with its whole body. A network error, a time limit, 429 and an answer of 500 or more are
 * tried again (withTries); the last try returns such an answer for the error of the caller.
 */
async function fetchWithTries(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; status: number; body: Buffer }> {
  return withTries(url, async (lastTry) => {
    const answer = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = Buffer.from(await answer.arrayBuffer());
    if (!lastTry && (answer.status === 429 || answer.status >= 500)) throw new Error(`HTTP ${answer.status}`);
    return { ok: answer.ok, status: answer.status, body };
  });
}

/**
 * Writes the repository of a devspace into the folder $1 of its workspace volume: the files of the pairs of path and
 * content after it, in one commit.
 */
const SEED_SCRIPT = `set -eu
mkdir -p "$1"
cd "$1"
shift
while [ $# -gt 1 ]; do
  mkdir -p "$(dirname "$1")"
  printf '%s' "$2" > "$1"
  shift 2
done
git init -q -b main
git add -A
git -c user.name=Test -c user.email=test@example.invalid commit -q -m 'Initial commit'
`;

/**
 * trustedExtensionAuthAccess of the product.json of the test VS Code names the extension for `github`. Dev Containers
 * is installed into the extensions folder of @vscode/test-cli (which then does not install it again), without its
 * attach question (scripts/attachQuestion.mjs). Returns the command line of the test VS Code.
 */
async function trustExtension(): Promise<TestVscode> {
  const requested = process.env.VSCODE_TEST_VERSION || 'stable';
  const executable = await withTries(`The download of VS Code ${requested}`, () => downloadAndUnzipVSCode(requested));
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
  await withTries('The installation of Dev Containers from the Marketplace', async () => {
    const install = childProcess.spawnSync(cli, [...cliArgs, '--install-extension', 'ms-vscode-remote.remote-containers'], { encoding: 'utf8' });
    log.info(`Dev Containers: exit code ${install.status}\n${install.stdout}${install.stderr}`);
    if (install.status !== 0) throw new Error(`exit code ${install.status}`);
  });
  const extensionsDir = cliArgs.find((arg) => arg.startsWith('--extensions-dir='))?.slice('--extensions-dir='.length);
  if (!extensionsDir) throw new Error(`No extensions folder in ${cliArgs.join(' ')}.`);
  for (const line of answerAttachQuestion(extensionsDir)) log.info(line);
  const productJson = path.join(path.dirname(executable), 'resources', 'app', 'product.json');
  const product = JSON.parse(fs.readFileSync(productJson, 'utf8')) as { quality?: string; trustedExtensionAuthAccess?: string[] | Record<string, string[]> };
  const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(productJson), 'package.json'), 'utf8')) as { version: string };
  log.info(`VS Code ${version} (${product.quality ?? 'no quality'}) in ${path.dirname(executable)}.`);
  const trusted = product.trustedExtensionAuthAccess;
  if (Array.isArray(trusted)) trusted.push(EXTENSION_ID);
  else product.trustedExtensionAuthAccess = { ...trusted, github: [...(trusted?.github ?? []), EXTENSION_ID] };
  fs.writeFileSync(productJson, JSON.stringify(product, null, '\t'));
  log.info(`${productJson}: trustedExtensionAuthAccess ${JSON.stringify(product.trustedExtensionAuthAccess)}`);
  return { cli, cliArgs, extensionsDir };
}

/** The command line of the test VS Code (with its extensions folder and user data folder) and its extensions folder. */
interface TestVscode {
  cli: string;
  cliArgs: string[];
  extensionsDir: string;
}

function folderUri(containerName: string, folder: string, docker?: WindowDocker): string {
  const parts = folderUriParts(containerName, folder, docker);
  return `${parts.scheme}://${parts.authority}${parts.path}`;
}

/**
 * The window of the container `name` on the host `host` of the list of Devspaces: it reaches the engine through its
 * Docker pipe, as a window that Devspaces opens (windowPipe.ts), at the address that this computer makes for the
 * container, with the ID of this computer that .vscode-test.mjs writes into the storage folder of the extension before
 * VS Code starts. The fields of the seed for the host.
 */
function hostWindow(host: string, computerId: string, name: string, folder: string): { folderUri: string; remoteHost: string; computerId: string; dockerHost: string } {
  const dockerHost = dockerPipeAddress(dockerPipeId(computerId, host, name), process.platform, dockerPipeBase(process.env, os.tmpdir())).dockerHost;
  return { folderUri: folderUri(name, folder, { host: dockerHost }), remoteHost: host, computerId, dockerHost };
}

/** The repository of the devspace of the attach tests: its devcontainer.json, its Dockerfile and a README. */
const ATTACH_FILES: Record<string, string> = {
  '.devcontainer/devcontainer.json': `${JSON.stringify(
    {
      name: 'Attach test',
      build: { dockerfile: 'Dockerfile' },
      remoteUser: 'node',
      postStartCommand: POST_START_COMMAND,
      postAttachCommand: 'date +%s >> /tmp/attach-count',
      customizations: { vscode: { settings: { 'remote.containers.copyGitConfig': true } } },
    },
    null,
    2,
  )}\n`,
  '.devcontainer/Dockerfile': DOCKERFILE,
  'README.md': '# Attach test\n',
};

/**
 * A devspace without container on the engine of `docker`: its workspace volume with the labels of the extension (the
 * test account owns it) and the repository `repository` with the files `files`, written by a container of the helper
 * image.
 */
async function seedDevspace(
  docker: BootstrapDocker,
  helperTag: string,
  repository = REPOSITORY,
  files = ATTACH_FILES,
  devspaceId = newDevspaceId(),
): Promise<{ devspaceId: string; name: string; folder: string }> {
  const name = resourceName(repository, devspaceId);
  const folder = repositoryFolder(repository);
  await docker.runChecked(['volume', 'create', '--label', `${LABEL_DEVSPACE_ID}=${devspaceId}`, '--label', `${LABEL_REPOSITORY}=${repository}`, '--label', `${LABEL_OWNER_ID}=${TEST_ACCOUNT_ID}`, name]);
  const pairs = Object.entries(files).flat();
  await docker.runChecked(['run', '--rm', '--pull', 'never', '--network', 'none', '--mount', `type=volume,source=${name},target=${WORKSPACES_ROOT}`, '--entrypoint', 'sh', helperTag, '-c', SEED_SCRIPT, 'sh', folder, ...pairs]);
  return { devspaceId, name, folder };
}

/** The helper image on the engine of `docker`, built as the extension builds it. */
async function helperImage(docker: BootstrapDocker, started: number): Promise<string> {
  const helper = await new HelperImages({ docker, logger: log, dockerfilePath: path.join(ROOT, 'resources', 'helper', 'Dockerfile') }).ensureImageUse();
  log.info(`Helper image ${helper.tag} (${((Date.now() - started) / 1000).toFixed(0)} s since the start).`);
  return helper.tag;
}

/**
 * The runs on the engine of the runner: the engine host (prepareEngineHost), the devspace, whose window reaches the
 * engine through the engine host, and the plain container, which Dev Containers opens with the Docker of the runner, as
 * "Attach to Running Container" does; the extension there reaches the engine through the engine host too.
 */
async function prepareLocal(docker: BootstrapDocker, dockerPath: string, started: number): Promise<Record<string, unknown>> {
  await prepareEngineHost(docker, dockerPath);
  const computerId = newComputerId();
  const { devspaceId, name, folder } = await seedDevspace(docker, await helperImage(docker, started));
  // The plain container has the dev image, built here; the build of the devspace finds its layers in the cache.
  await docker.runChecked(['build', '-t', PLAIN_IMAGE, '-'], { input: DOCKERFILE, timeoutMs: 300_000 });
  const plain = `attach-test-plain-${crypto.randomBytes(3).toString('hex')}`;
  await docker.runChecked(['run', '-d', '--name', plain, PLAIN_IMAGE, 'sleep', 'infinity']);
  return {
    devspace: { containerName: name, folder, ...hostWindow(ENGINE_HOST, computerId, name, folder), user: 'node', devspaceId, longStartSeconds: LONG_START_SECONDS, longStartMark: LONG_START_MARK },
    plain: { containerName: plain, folder: '/tmp', folderUri: folderUri(plain, '/tmp'), remoteHost: ENGINE_HOST, computerId, user: 'root' },
  };
}

/**
 * A container of the runner with the SSH server of REMOTE_HOST_IMAGE for root (its start script `start`, the options
 * `options` of `docker run`), and the host `host` in the SSH config of the runner, with its own key and known_hosts
 * file in ~/.ssh, which points to it.
 */
async function startSshHost(local: BootstrapDocker, host: string, container: string, options: string[], start: string): Promise<void> {
  await local.runChecked(['build', '-t', REMOTE_HOST_IMAGE, '-'], { input: REMOTE_HOST_DOCKERFILE, timeoutMs: 300_000 });
  const sshFolder = path.join(os.homedir(), '.ssh');
  fs.mkdirSync(sshFolder, { recursive: true, mode: 0o700 });
  const key = path.join(sshFolder, host);
  for (const file of [key, `${key}.pub`]) fs.rmSync(file, { force: true });
  childProcess.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', host, '-f', key]);
  const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim();
  await local.runChecked(['run', '-d', '--name', container, '--init', '-p', '127.0.0.1::22', '-e', `AUTHORIZED_KEY=${publicKey}`, ...options, '--entrypoint', 'sh', REMOTE_HOST_IMAGE, '-c', start]);
  const port = Number((await local.runChecked(['port', container, '22/tcp'])).trim().split('\n')[0].split(':').pop());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`The SSH port of ${container} was not found.`);
  const hostKey = (await local.runChecked(['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])).trim().split(' ').slice(0, 2).join(' ');
  const knownHosts = path.join(sshFolder, `${host}.known_hosts`);
  fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });
  const config = path.join(sshFolder, 'config');
  const entry = [`Host ${host}`, '  HostName 127.0.0.1', `  Port ${port}`, '  User root', `  IdentityFile ${key}`, '  IdentitiesOnly yes', '  StrictHostKeyChecking yes', `  UserKnownHostsFile ${knownHosts}`];
  // ssh takes the first value of each option, so the entry comes first (before a `Host *` of the runner), and the entry
  // of an earlier preparation on this runner is removed from the rest.
  const rest = fs.existsSync(config) ? fs.readFileSync(config, 'utf8').replace(new RegExp(`^Host ${host}\\n(?:[ \\t]+.*(?:\\n|$))*`, 'gm'), '').trim() : '';
  fs.writeFileSync(config, `${entry.join('\n')}\n${rest === '' ? '' : `\n${rest}\n`}`, { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  log.info(`${config}: ${entry.join('; ')}`);
}

/** The Docker CLI with DOCKER_HOST=ssh://`host`, as the extension reaches a host of its list, once its engine answers. */
async function sshHostDocker(dockerPath: string, host: string): Promise<BootstrapDocker> {
  const endpoint = sshEndpoint(host);
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: endpoint };
  delete env.DOCKER_CONTEXT;
  const docker = new BootstrapDocker(new NodeProcessRunner(), dockerPath, env, log);
  for (const deadline = Date.now() + REMOTE_ENGINE_WAIT_MS; ; ) {
    const info = await docker.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 });
    if (info.exitCode === 0) {
      log.info(`The Docker engine ${info.stdout.trim()} of ${host} answers through ${endpoint}.`);
      return docker;
    }
    if (Date.now() > deadline) throw new Error(`The Docker engine of ${host} does not answer: ${(info.stderr || info.stdout).trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * The engine host (ENGINE_HOST_START) with the Docker socket of the runner, and the host ENGINE_HOST in the SSH config
 * of the runner. .vscode-test.mjs makes it the Docker host of Devspaces in its storage folder, as "Use a Remote Docker
 * Host…" does. The check that its engine is the engine of the runner: a volume that only the runner made. `options`: more
 * options of its `docker run`.
 */
async function prepareEngineHost(local: BootstrapDocker, dockerPath: string, host = ENGINE_HOST, container = ENGINE_HOST_CONTAINER, options: string[] = []): Promise<void> {
  await startSshHost(local, host, container, ['--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', ...options], ENGINE_HOST_START);
  const remote = await sshHostDocker(dockerPath, host);
  const mark = `attach-test-engine-${crypto.randomBytes(3).toString('hex')}`;
  await local.runChecked(['volume', 'create', mark]);
  const seen = (await remote.runChecked(['volume', 'ls', '-q', '--filter', `name=^${mark}$`])).trim();
  await local.runChecked(['volume', 'rm', mark]);
  if (seen !== mark) throw new Error(`The engine of ${host} is not the engine of the runner: it has no volume ${mark}.`);
}

/**
 * The run `gif`: the README GIF (test/gif/record.mjs). The engine host has the name GIF_HOST, as a server of a school,
 * and the devspace is the demo repository GIF_REPOSITORY with a small web page, without container. Its image is built
 * once here (GIF_WARM_IMAGE), so that the build at the start in the GIF finds its layers in the cache, and the image of
 * the engine host has a name of the school server (GIF_HOST_IMAGE). The engine host gets the Docker data folder of the
 * runner, read-only: the utilization page reads the disk of that folder on the host, and the volume of its image
 * docker:dind at that folder would show in the view Docker Hosts as a volume without a name. The ID of the devspace has
 * a short name pair (GIF_NAME_PAIR_LENGTH).
 */
async function prepareGif(docker: BootstrapDocker, dockerPath: string, started: number): Promise<Record<string, unknown>> {
  const dataFolder = (await docker.runChecked(['info', '--format', '{{.DockerRootDir}}'])).trim();
  await prepareEngineHost(docker, dockerPath, GIF_HOST, GIF_HOST_CONTAINER, ['--mount', `type=bind,source=${dataFolder},target=${dataFolder},readonly`]);
  await docker.runChecked(['tag', REMOTE_HOST_IMAGE, GIF_HOST_IMAGE]);
  await docker.runChecked(['image', 'rm', REMOTE_HOST_IMAGE]);
  let shortId = newDevspaceId();
  while (namePair(shortId).length > GIF_NAME_PAIR_LENGTH) shortId = newDevspaceId();
  const { devspaceId, name, folder } = await seedDevspace(docker, await helperImage(docker, started), GIF_REPOSITORY, GIF_FILES, shortId);
  await docker.runChecked(['build', '-t', GIF_WARM_IMAGE, '-'], { input: DOCKERFILE, timeoutMs: 300_000 });
  await docker.runChecked(['image', 'rm', GIF_WARM_IMAGE]);
  return { gif: { repository: GIF_REPOSITORY, volumeName: name, folder, devspaceId, remoteHost: GIF_HOST, computerId: newComputerId(), accountId: TEST_ACCOUNT_ID } };
}

/**
 * The run `remote`: the other computer (REMOTE_HOST_DOCKERFILE) with the host REMOTE_HOST in the SSH config of the runner
 * (its own key and known_hosts file in ~/.ssh), the helper image and the devspace on its engine (reached with
 * DOCKER_HOST=ssh://REMOTE_HOST, as the extension reaches a host of its list), and on the engine of the runner a
 * container with the name of the devspace container. The current Docker context of the runner stays `default`:
 * .vscode-test.mjs makes REMOTE_HOST the Docker host of Devspaces in its storage folder, as "Use a Remote Docker Host…"
 * does, which changes no Docker context.
 */
async function prepareRemote(local: BootstrapDocker, dockerPath: string, started: number): Promise<Record<string, unknown>> {
  await startSshHost(
    local,
    REMOTE_HOST,
    REMOTE_HOST_CONTAINER,
    ['--privileged', '-e', 'DOCKER_TLS_CERTDIR=', '--mount', `type=volume,source=${REMOTE_HOST_DOCKER_VOLUME},target=/var/lib/docker`],
    REMOTE_HOST_START,
  );
  const remote = await sshHostDocker(dockerPath, REMOTE_HOST);
  const { devspaceId, name, folder } = await seedDevspace(remote, await helperImage(remote, started));
  await local.runChecked(['run', '-d', '--name', name, '--entrypoint', 'sh', REMOTE_HOST_IMAGE, '-c', 'exec tail -f /dev/null']);
  // After the last SSH login of the preparation: remote.test.ts counts the logins from this time.
  const preparedAt = new Date().toISOString();
  return {
    remote: { containerName: name, folder, ...hostWindow(REMOTE_HOST, newComputerId(), name, folder), user: 'node', devspaceId, remoteHostContainer: REMOTE_HOST_CONTAINER, preparedAt },
  };
}

/**
 * The last release of this repository on GitHub and its VSIX, downloaded into `folder`: the file that the release
 * workflow attaches to the GitHub release (its publish job publishes this file to the Marketplace). The test installs
 * this file, so that it does not depend on the listing of the Marketplace. The token (GITHUB_TOKEN, see main) only
 * raises the rate limit of the GitHub API. Undefined when the repository has no release of this extension ID yet: no
 * release at all, or a latest release whose VSIX is not the package `<name>-<version>.vsix` of the name of this
 * checkout (a release of another ID, see the section Naming of CONTRIBUTING.md).
 */
async function latestReleaseVsix(folder: string, token: string | undefined): Promise<{ tag: string; file: string } | undefined> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is not set (GitHub Actions sets it).');
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const answer = await fetchWithTries(`https://api.github.com/repos/${repository}/releases/latest`, headers, 30_000);
  if (answer.status === 404) {
    log.info(`${repository} has no release.`);
    return undefined;
  }
  if (!answer.ok) throw new Error(`The latest release of ${repository} could not be read: ${answer.status} ${answer.body.toString('utf8')}`);
  const release = JSON.parse(answer.body.toString('utf8')) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const assets = release.assets.filter((asset) => asset.name.endsWith('.vsix'));
  if (assets.length !== 1) throw new Error(`The release ${release.tag_name} of ${repository} has ${assets.length} VSIX files: ${assets.map((asset) => asset.name).join(', ')}`);
  const { name } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string };
  if (assets[0].name !== `${name}-${release.tag_name.replace(/^v/, '')}.vsix`) {
    log.info(`The latest release ${release.tag_name} of ${repository} holds ${assets[0].name}, not a package of ${name}.`);
    return undefined;
  }
  const download = await fetchWithTries(assets[0].browser_download_url, {}, 120_000);
  if (!download.ok) throw new Error(`${assets[0].browser_download_url} could not be downloaded: ${download.status}`);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, assets[0].name);
  fs.writeFileSync(file, download.body);
  return { tag: release.tag_name, file };
}

/**
 * The VSIX of this checkout in `folder`, as `npm run package` builds it, for the first version of an extension ID: with
 * no release of the ID (latestReleaseVsix), the run `previous` runs this version, and the update installs it again.
 */
function checkoutVsix(folder: string): { tag: string; file: string } {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${name}-${version}.vsix`);
  const build = childProcess.spawnSync('npm', ['run', '-s', 'package', '--', '--out', file], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`The VSIX of this checkout could not be built: exit code ${build.status}\n${build.stdout}${build.stderr}`);
  log.info(`No release of ${EXTENSION_ID} exists yet: the run previous runs the VSIX of this checkout, version ${version}.`);
  return { tag: `v${version}`, file };
}

/**
 * The helper image of the released version in `folder` (its extension folder), built as that version builds it when it
 * is missing (helperImage.ts, ensureHelperImageUse): the tag from its Dockerfile and the CLI version of its package.json
 * (helperImageTag), with that CLI version as the build argument. The CLI version of this checkout can be another one
 * (Dependabot updates it), and that version restores the devspace at activation only when its own tag exists. The image
 * name, its label and the helper generation are those of this checkout.
 */
async function releasedHelperImage(docker: BootstrapDocker, folder: string, started: number): Promise<string> {
  const dockerfile = path.join(folder, 'resources', 'helper', 'Dockerfile');
  // As scripts/cliVersion.mjs reads it; that module uses import.meta, which the CommonJS bundle of this file has not.
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { devDependencies?: Record<string, unknown> };
  const cliVersion = manifest.devDependencies?.['@devcontainers/cli'];
  if (typeof cliVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(cliVersion)) {
    throw new Error(`The package.json of the released version has no exact version of @devcontainers/cli: ${JSON.stringify(cliVersion)}`);
  }
  const tag = helperImageTag(fs.readFileSync(dockerfile, 'utf8'), cliVersion);
  if (!(await docker.imageExists(tag))) {
    await docker.buildImage({ tag, dockerfile, context: path.dirname(dockerfile), labels: { [LABEL_HELPER]: 'true' }, buildArgs: { DEVCONTAINER_CLI_VERSION: cliVersion } });
  }
  log.info(`Helper image ${tag} of the released version, CLI ${cliVersion} (this checkout: ${DEVCONTAINER_CLI_VERSION}), ${((Date.now() - started) / 1000).toFixed(0)} s since the start.`);
  return tag;
}

/** Whether the version `a` (major.minor.patch) is greater than `b`. */
function newerVersion(a: string, b: string): boolean {
  const [pa, pb] = [a, b].map((value) => value.split('.').map((part) => Number.parseInt(part, 10)));
  for (let index = 0; index < 3; index++) if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) > (pb[index] ?? 0);
  return false;
}

/**
 * The runs `previous` and `updated`: the last released version of the extension, installed from the VSIX of its GitHub
 * release into the extensions folder of the test VS Code as users install a VSIX, the helper image of that version
 * (releasedHelperImage), and the devspace without container. The seed names the version and the SHA-256 of its
 * dist/extension.js, so that the run `previous` can check that VS Code loads it. The image name, label and generation of
 * the helper image and the volume labels of the devspace are those of this checkout: a version that changes them must
 * build the image or seed the devspace with those of the released version here. A checkout older than the latest
 * release fails: its VSIX would replace a newer version (a downgrade). Before the first release of the extension ID,
 * the released version is the VSIX of this checkout (checkoutVsix).
 */
async function prepareUpdate(docker: BootstrapDocker, dockerPath: string, vscode: TestVscode, started: number, githubToken: string | undefined): Promise<Record<string, unknown>> {
  const previousFolder = path.join(ROOT, 'out', 'test', 'vscode', 'attach', 'previous');
  const release = (await latestReleaseVsix(previousFolder, githubToken)) ?? checkoutVsix(previousFolder);
  const install = childProcess.spawnSync(vscode.cli, [...vscode.cliArgs, '--install-extension', release.file], { encoding: 'utf8' });
  log.info(`${release.file} of the release ${release.tag}: exit code ${install.status}\n${install.stdout}${install.stderr}`);
  if (install.status !== 0) throw new Error(`${release.file} could not be installed.`);
  const folders = fs.readdirSync(vscode.extensionsDir).filter((name) => name.toLowerCase().startsWith(`${EXTENSION_ID}-`));
  if (folders.length !== 1) throw new Error(`${vscode.extensionsDir} has ${folders.length} folders of ${EXTENSION_ID}: ${folders.join(', ')}`);
  const folder = path.join(vscode.extensionsDir, folders[0]);
  const version = (JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { version: string }).version;
  if (release.tag !== `v${version}`) throw new Error(`The release ${release.tag} holds the version ${version}.`);
  const own = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  if (newerVersion(version, own)) throw new Error(`The latest release ${version} is newer than the version ${own} of this checkout: the update would be a downgrade. Merge main.`);
  const extensionSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, 'dist', 'extension.js'))).digest('hex');
  log.info(`The previous version ${version} is in ${folder} (dist/extension.js ${extensionSha256}).`);
  await prepareEngineHost(docker, dockerPath);
  const helper = await releasedHelperImage(docker, folder, started);
  const { devspaceId, name, folder: repository } = await seedDevspace(docker, helper);
  return {
    devspace: { containerName: name, folder: repository, ...hostWindow(ENGINE_HOST, newComputerId(), name, repository), user: 'node', devspaceId, previous: { version, extensionSha256 } },
  };
}

async function main(): Promise<void> {
  if (process.env.CI !== 'true') throw new Error('The attach tests use the Docker engine as a real installation does. They run only on CI (CI=true).');
  const started = Date.now();
  // The preparation `update` reads the latest release with it; no program that the preparation starts gets it.
  const githubToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const vscode = await trustExtension();
  const dockerPath = findDockerCli(process.env, process.platform);
  if (!dockerPath) throw new Error('The Docker CLI was not found.');
  const docker = new BootstrapDocker(new NodeProcessRunner(), dockerPath, process.env, log);
  const kind = process.env.DEVSPACE_TEST_ATTACH_PREPARE;
  const seed =
    kind === 'remote'
      ? await prepareRemote(docker, dockerPath, started)
      : kind === 'update'
        ? await prepareUpdate(docker, dockerPath, vscode, started, githubToken)
        : kind === 'gif'
          ? await prepareGif(docker, dockerPath, started)
          : await prepareLocal(docker, dockerPath, started);
  const file = path.join(ROOT, 'out', 'test', 'vscode', 'attach', 'seed.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  log.info(`${file}: ${JSON.stringify(seed)}`);
  log.info(`Prepared in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
}

allowSlowConnects();
// The process ends also when a program that it started still runs: after a failed try of its download, @vscode/test-electron
// leaves the `tar` of that try running, which waits for the rest of the archive forever, and Node.js waits for that child
// process (run 42254008768 waited 10 minutes after "Prepared in 72 s." until the time limit of the job).
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
