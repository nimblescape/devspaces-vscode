# Contributing

This guide explains the files, the development, the tests and the release of
the extension. The [README](README.md) describes the use in short, the
[user guide](docs/guide.md) in full. How the extension works inside is in
[architecture.md](docs/architecture.md), its security model in
[security.md](docs/security.md). What the extension must do is in
[requirements.md](docs/requirements.md), with an ID for each requirement
that a pull request can name.

## Files

| File | Purpose |
| --- | --- |
| `src/` | The extension in TypeScript: `src/vscode` holds the editor wiring, `src/core` the logic without the editor API, and `src/helperChannel` the worker that runs in the workspace helper container. The tests (`*.test.ts`) sit beside the modules. |
| `test/docker/` | The integration tests against a running Docker engine. |
| `test/vscode/` | The tests in a real VS Code: mocha runs them in the extension host of a VS Code that `@vscode/test-cli` downloads. `test/vscode/host/` is a development extension without code, for the tests of the packaged VSIX. `test/vscode/attach/` holds the attach tests, `test/vscode/github/` the sign-in provider `github` that they use instead of the real GitHub sign-in, and `test/vscode/untrusted/` the tests in a folder that VS Code does not trust. |
| `resources/` | The files of the package beside the bundles: the icons, the Dockerfile of the workspace helper, and the editor of the repository groups. |
| `scripts/` | The build of the icon font, the local installation, the Marketplace setup of the repository (`marketplace-setup.sh`), the reset of a Docker engine for tests (`purge-docker-context.sh`), the pin of the Docker CLI of Devspaces (`docker-cli-pin.mjs`, see the workflow "Docker CLI" below), the pin of the build image of Devspaces (`buildx-pin.mjs`, see the workflow "Buildx image" below), and the programs of the tests in a real VS Code, for example `vscode-with-trust.mjs`, which starts the test VS Code without `--disable-workspace-trust` for the configuration `untrusted`. |
| `docs/` | The requirements (`requirements.md`), the user guide, the architecture, the security model, and how the remote connection works (`remote-connection.md`). `docs/design/` holds design proposals as they were written; the code can differ from them. |
| `esbuild.mjs` | Bundles the three entry points into `dist/` as readable JavaScript (not minified, with the names of the source), with the options of `scripts/bundleOptions.mjs`. Only a development build writes source maps, and not for `dist/helperChannel.js`. |
| `tsconfig.json` | The TypeScript settings of the type check with TypeScript 6.0: strict, and no output, because esbuild builds the bundles. They are the same in every nimblescape extension, except the files they include. |
| `eslint.config.mjs` | The rules of `npm run lint`: the recommended rules of ESLint and of typescript-eslint, and the rules that find promises that nobody waits for, with the types of `tsconfig.json`. The file is the same in every nimblescape extension, except its lists of the ignored files and of the scripts of webviews. |
| `.vscode-test.mjs` | The configurations of the tests in a real VS Code: `vscode` for the development build (`npm run test:vscode`), `vsix` for the packaged VSIX (`npm run test:vscode:vsix`), `untrusted` for the packaged VSIX in a local folder that VS Code does not trust (Restricted Mode, also `npm run test:vscode:vsix`), and `attach` for the attach tests (only when `DEVSPACE_TEST_ATTACH` is `plain`, `devspace`, `reattach`, a restart of VS Code in the window of the devspace, `account`, that window under another GitHub account, `longopen`, that window with an open pipeline of several minutes, `remote`, the window of a devspace on the Docker engine of another computer over SSH, `stopped`, a local folder whose tests start a second VS Code in the window of the devspace and stop and remove its container, `previous`, the window of the devspace with the last released version of the extension, or `updated`, that window again after the update to the VSIX of the checkout), with the VS Code version, the test files in `out/test/vscode/`, and the options of VS Code and mocha. |
| `package.json` | The extension manifest. The section [Manifest](#manifest) explains it. |
| `package-lock.json` | The locked development tools. npm writes this file, and nobody edits it by hand. |
| `.node-version` | The Node release of the release workflow and of `npm run package`. `actions/setup-node` in the workflows and local Node version managers read it. |
| `.github/workflows/ci.yml` | Checks the types and the code (ESLint), tests and packages every push to `main` and every pull request that changes more than the documentation (Markdown files and the files of `docs/`), and the commit of every release, runs the unit tests a second time as root, fails when a unit test ran in neither run, runs the integration tests against Docker, and runs the tests in a real VS Code under a virtual display (`xvfb-run`). The jobs run side by side: the job "package" builds the VSIX without waiting for the tests, the jobs "vscode" test it as soon as it is there, and the attach tests run in six parts side by side, one for each run that needs no other run before it: "vscode attach (plain)", "vscode attach (reattach)", "vscode attach (account)", "vscode attach (longopen)", "vscode attach (stop)" and "vscode attach (removal)"; each part except "plain" first runs the run `devspace`, in which the devspace gets its container. Each job takes the npm packages from the cache of GitHub Actions, which `npm ci` checks against `package-lock.json`. After the tests in VS Code of the job "vscode" on Linux, `node scripts/leftoverPrograms.mjs` fails when a program of that VS Code still runs 10 seconds after it quit, except the `docker exec` programs of Dev Containers and their `ssh` programs. The release publishes the VSIX of this workflow. |
| `.github/workflows/release.yml` | Releases a version on a manual start: commits the version to a temporary branch, tests and packages it with `ci.yml`, and only then moves `main` to it, creates its tag and GitHub release and publishes it to the Marketplace. A dry run tests without a change. The section [Release](#release) explains it. |
| `.github/workflows/vscode-versions.yml` | Runs the VS Code jobs of `ci.yml` once per week (Mondays at 04:23 UTC) and on a manual start, on VS Code Insiders and on the version of `engines.vscode` in `package.json`, the lowest version that the extension supports. A change of the workflow runs it on its pull request. The VS Code CLI installs the newest release of Dev Containers that supports the VS Code version, and the tests print both versions. Each attach job keeps the Insiders build that is the newest at its start. GitHub documents that it sends the notice of a failed scheduled run to the person who last changed the `cron` line, and that it turns off the schedule of a public repository after 60 days without activity in the repository; the tab "Actions" turns it on again. |
| `.github/workflows/daily-checks.yml` | Runs the daily checks of the pins in one run, every day at 04:41 UTC and on a manual start: its jobs call `docker-cli.yml`, `buildx-image.yml` and `vm-image.yml`, side by side, so that a failed check does not stop the others. A day without a new version opens no pull request. A change of the workflow runs it on its pull request, where the called workflows write nothing. Dependabot checks the npm packages and the pinned actions on its own schedule (see `.github/dependabot.yml` below). |
| `.github/workflows/docker-cli.yml` | Keeps the pin of the Docker CLI of Devspaces (`src/core/docker/dockerCliPin.json`, see [architecture.md](docs/architecture.md#the-docker-cli-of-devspaces)) up to date, every day through the workflow "Daily checks" and on a manual start. Its job "pin" downloads the files of the pin again and fails when Docker replaced one of them, and then runs `node scripts/docker-cli-pin.mjs`, which writes the newest version that `download.docker.com` has for all platforms, with the size and SHA-256 of each file, and the Docker API versions that the CLI speaks (`api`, its oldest and its newest one). The script measures them with the Linux build of the CLI against a fake engine, in a container of the local Docker engine without network and without the files of the computer, because nothing checks a new CLI before its pin; so a new pin needs Linux on x86_64 or aarch64 with Docker, and the check of the current pin fails there when the CLI speaks other API versions than the pin names. When the pin changed, its job "pull request" pushes the branch `docker-cli-<version>`, opens a pull request for it, and starts the workflow "CI" on that branch, because a pull request of a workflow starts no workflow; the checks appear on the pull request. A branch whose pull request exists, open, closed or merged, gets nothing new. Opening the pull request needs the repository setting "Allow GitHub Actions to create and approve pull requests" (Settings > Actions > General). A pull request that changes the workflow, the script or the pin runs the job "pin" only. By hand: `node scripts/docker-cli-pin.mjs` (newest version), `--version <x.y.z>`, or `--check` (writes nothing). |
| `.github/workflows/buildx-image.yml` | Keeps the pin of the build image of Devspaces (`src/core/docker/buildxPin.json`, see [architecture.md](docs/architecture.md#the-helper-image)) up to date, every day through the workflow "Daily checks" and on a manual start. Its job "pin" checks that Docker Hub still has the image index of the pinned digest of `docker/buildx-bin`, with an image for `linux/amd64` and `linux/arm64`, and then runs `node scripts/buildx-pin.mjs`, which writes the newest tag x.y.z of `docker/buildx-bin` (no release candidate) with the digest of its image index; the script reads Docker Hub without a login and checks each digest against the SHA-256 of the bytes. When the pin changed, its job "pull request" pushes the branch `buildx-<version>`, opens a pull request for it, and starts the workflow "CI" on that branch, whose Docker tests build the helper image in a container of the new build image. A branch whose pull request exists, open, closed or merged, gets nothing new. Opening the pull request needs the same repository setting as the workflow "Docker CLI". A pull request that changes the workflow, the script or the pin runs the job "pin" only. By hand: `node scripts/buildx-pin.mjs` (newest version), `--version <x.y.z>`, or `--check` (writes nothing). |
| `.github/workflows/vm-image.yml` | Builds and tests the image of the VM of Devspaces (`vm/`, see [architecture.md](docs/architecture.md#the-image-of-the-vm)) every day through the workflow "Daily checks" and on a manual start. Its jobs "build" run `vm/build.sh` on an amd64 and an arm64 runner; "kernel check" checks the kernels of the image and the newest kernel of WSL of Microsoft against the options that Docker Engine requires; "start test" starts the disk for Lima of amd64 with QEMU and KVM (`vm/test/start-test.sh`). Only on `main`, after these jobs passed, the job "push" runs `node scripts/vm-image.mjs push`, which pushes the files to `ghcr.io/nimblescape/devspaces-vm` only when the lists of their packages or the recipe changed since the newest version there, writes the pin `src/core/vm/vmImagePin.json`, and reads the files back without a login. As long as the pin names no version and ghcr.io has none, nothing is pushed: the first push needs a manual start with "first push", and the package must be public (when it is not public yet, that run fails after the push, and the next run opens the pull request). When the pin changed, its job "pull request" pushes the branch `vm-image-<version>`, opens a pull request for it, closes the older open pull requests of the image, and starts the workflow "CI" on that branch; the job "prune" deletes the versions on ghcr.io except those of the published releases, of the pin on `main`, and the newest 5. Opening the pull request needs the same repository setting as the workflow "Docker CLI". A pull request that changes the workflow, `vm/`, the script or the pin runs build, kernel check and start test, which write nothing. By hand: `vm/build.sh <amd64|arm64> <folder>` on Linux with Docker of that architecture; `node scripts/vm-image.mjs key <folder>` or `check`. |
| `.github/workflows/marketplace-identity.yml` | Prints the Marketplace member ID of the publishing identity, to check the setup of the repository. |
| `.github/dependabot.yml` | Proposes daily updates (at 04:17 and 04:29 UTC) of the npm packages, also the Dev Container CLI of the helper image, and of the pinned actions. TypeScript stays at 6.0.3, as in every nimblescape extension. |
| `.vscodeignore` | Lists the files of the package: the bundles in `dist/`, `resources/`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `ThirdPartyNotices.txt` and `SUPPORT.md`. |

## Development

Everything runs on Node.js 24: the release in `.node-version` for the tools,
the tests and CI, including
[`@vscode/vsce`](https://github.com/microsoft/vscode-vsce), the Microsoft tool
that packages and publishes extensions, and the runtime of VS Code 1.125 and
later (`engines.vscode`) for the extension.

| Command | Effect |
| --- | --- |
| `npm ci` | Installs the locked development tools. |
| `npm run typecheck` | Checks the types with `tsc`. |
| `npm run lint` | Checks the code with ESLint (`eslint.config.mjs`). `npm run lint -- --fix` corrects what ESLint can correct itself. |
| `npm test` | Runs the unit tests with vitest, without VS Code and without Docker. The tests of the helper scripts that run as root in the helper container (`chown` to other users, `mknod`, `mount --bind`) need root and skip themselves for another user, and a few tests need a user without root; `sudo npm test` on Linux runs the tests as root. |
| `npm run test:docker` | Runs the integration tests against the running Docker engine. |
| `npm run test:vscode` | Builds `dist/` and the tests of `test/vscode/`, downloads VS Code (stable, or the version in the environment variable `VSCODE_TEST_VERSION`) and the Dev Containers extension to `.vscode-test/`, and runs the tests in that VS Code with the extension from `dist/`. That VS Code gets its own user data folder and a `DOCKER_HOST` without a Docker engine, so the tests never touch your VS Code settings or your Docker engine. It needs network access to the VS Code downloads and the Marketplace. On Linux without a display, run `xvfb-run -a npm run test:vscode`. |
| `npm run test:vscode:vsix` | Runs the same tests against the packaged VSIX of the version in `package.json`, as users install it: run `npm run package` first. VS Code installs the VSIX and the Dev Containers extension, and loads `test/vscode/host/` as development extension, so that the extension runs from the VSIX. Then the same tests and those of `test/vscode/untrusted/` run in a folder that VS Code does not trust: they check that the extension runs there and that the folder's values of the settings in `capabilities.untrustedWorkspaces.restrictedConfigurations` of `package.json` are ignored. On Linux without a display, run it under `xvfb-run -a`. On Windows, the path of the checkout must have no space: `@vscode/test-cli` passes the path of the VSIX to the VS Code command line without quotes. |
| `npm run test:vscode:attach:prepare` and `npm run test:vscode:attach` | The attach tests, only on CI (the six jobs from "vscode attach (plain)" to "vscode attach (removal)", "vscode attach remote", whose preparation runs with `DEVSPACE_TEST_ATTACH_PREPARE=remote`, and "vscode update", with `DEVSPACE_TEST_ATTACH_PREPARE=update`): VS Code starts in the window of a container on the real Docker engine, through the real Dev Containers extension, and the extension creates its objects there with the names of a real installation. The preparation refuses to run without `CI=true`. It changes the test copies of VS Code and Dev Containers in `.vscode-test/`: VS Code lets the extension use the test sign-in without a question, and Dev Containers does not ask before the first attach (VS Code refuses every dialog in tests). `npm run test:vscode:attach` makes the same change of Dev Containers before each run, in every release of it in `.vscode-test/extensions`, because VS Code can install a newer release during a run. With `DEVSPACE_TEST_ATTACH_PREPARE=remote`, it prepares no devspace and no plain container on the local Docker; instead it starts a container with a Docker engine and an SSH server, puts the devspace on that engine, starts a container with the name of the devspace container on the local Docker (the window must not use it), and adds the host `devspaces-test-remote` to the SSH config in `~/.ssh`; the run `remote` starts with that host as the Docker host of Devspaces in its own list (`remote-docker.json` in the storage folder of the test VS Code, as after "Use a Remote Docker Host…"), and the current Docker context stays `default`. The SSH server there writes the command of each session into the log of its container, and the first test of the run `remote` counts the SSH logins of the open in that log and writes them, with the time of each session, to the log of the test and to the summary of the CI job. With `DEVSPACE_TEST_ATTACH_PREPARE=update`, it prepares no plain container; it installs the last released version of the extension into `.vscode-test/extensions` from the VSIX that the release workflow attached to the latest GitHub release (its publish job publishes this file to the Marketplace), and it builds the helper image as that version builds it (from its Dockerfile and its version of the Dev Container CLI). Before the runs `stopped` and `updated`, `node scripts/install-attach-extensions.mjs` packages the extension and the test sign-in provider and installs them from their VSIX files into `.vscode-test/extensions`, over an installed version too: the second VS Code of the run `stopped` loads them as users install them, because VS Code closes a window of development extensions when its remote connection is lost, and the run `updated` checks that VS Code loads the packaged build after the update. The run `stopped` stops and then removes the container; with `DEVSPACE_TEST_STOPPED=stop` or `DEVSPACE_TEST_STOPPED=removal` it runs only one of them, as the jobs "vscode attach (stop)" and "vscode attach (removal)" do. `npm run test:vscode:attach` fails when mocha reports no result, also when VS Code ends with exit code 0. After each run, it lists the programs that the test VS Code left running (on Linux, `scripts/leftoverPrograms.mjs`, also for the second VS Code of the run `stopped`) and fails when a program that started during the run still runs 10 seconds after VS Code quit. The `docker exec` programs of Dev Containers and their `ssh` programs do not count, and the run `previous`, with the last released version of the extension, only lists the programs. |
| `npm run build` | Bundles `dist/extension.js`, `dist/groupsPreviewWorker.js` and `dist/helperChannel.js` as readable JavaScript, the first two with source maps. `npm run package` builds them without source maps. |
| `npm run package` | Builds `nimblescape-devspaces-2-<version>.vsix` with vsce. vsce also validates the manifest and the README. |
| `npm run install-local` | Builds the package and installs it into every VS Code profile (`-- --profile <name>` into one). |
| `npm run uninstall-local` | Removes `nimblescape.nimblescape-devspaces-2` from every VS Code profile (`-- --profile <name>` from one). |
| `code --install-extension nimblescape-devspaces-2-<version>.vsix` | Installs the built package. Reload the window after an update of an active extension. |
| `bash scripts/purge-docker-context.sh --dry-run` | Shows what a reset of the engine of the current Docker context removes. Without `--dry-run`, it removes **everything** on that engine (all containers, volumes, images, unused networks and the build cache, not only those of Devspaces), after you type the name of the context, so that the next start begins like a fresh installation. Changes that are not pushed are lost. |

## Reviewing the package

The VSIX holds the three bundles of `dist/` as readable JavaScript: not
minified, with the names of the source, and with a comment that names each
source file. To compare a VSIX with the sources, unpack it (a VSIX is a ZIP
file), run `npm ci` and `npm run vscode:prepublish` at the tag of its version,
and compare `extension/dist/` of the VSIX with `dist/`. With the same sources
and the locked versions of the tools, the build gives the same files.

## Manifest

`package.json` is the extension manifest. It has these parts:

- The name and the publisher define the extension ID `nimblescape.nimblescape-devspaces-2`; the section [Naming](#naming) explains the name.
- The version is the only source of the package version, and the tag of a release names it.
- The engine range defines the compatible VS Code versions, and `extensionDependencies` the Dev Containers extension.
- `main` selects the bundle `dist/extension.js`.
- `contributes` declares the view, the commands, the menus, the settings and the icons.
- `capabilities.untrustedWorkspaces` lets the extension run in a folder that VS Code does not trust (Restricted Mode). Its list `restrictedConfigurations` names every setting without the scope `application` or `machine`, so that VS Code ignores the values of the workspace or folder for it there. A new setting of that kind also goes into this list (a unit test in `src/vscode/settings.test.ts` checks it) and into the folder settings of `untrustedConfiguration` in `.vscode-test.mjs`.
- `capabilities.virtualWorkspaces` is `true`: Devspaces reads no file of the workspace. It only reads the address of the workspace folder, to find the devspace of the window, so it also runs in a window of a virtual workspace, for example a repository opened with GitHub Repositories.
- The icon of the Marketplace is `resources/icon.png`, the sidebar icon `resources/icon.svg` on a blue tile, because the Marketplace takes no SVG icon. Both show the codicon `open-in-window` of Microsoft, and `scripts/build-icon-font.py` builds the icon font `resources/icons/devspace-icons.woff` from codicon shapes. The Codicons are under CC BY 4.0: a new or changed codicon needs its entry in `ThirdPartyNotices.txt`. The description, categories, keywords and the banner color complete the Marketplace page.
- The development dependencies are the build, test and packaging tools, and `@devcontainers/cli` at the exact version of the Dev Container CLI in the workspace helper (`scripts/cliVersion.mjs`; the package is neither bundled nor shipped). `overrides` pins newer versions of packages inside `@vscode/test-cli` (mocha's `diff`, `glob` and `serialize-javascript`), and `allowScripts` lists the install scripts of dependencies that npm 11.19 and later may run: those of esbuild and `@vscode/vsce-sign` in every version, because the build and the packaging (`npm run package`) run the code of both packages anyway and Dependabot updates them, and not the one of fsevents, an optional package for macOS that already contains its built binary. The manifest declares no runtime dependency.

`README.md` is the page of the Marketplace and `CHANGELOG.md` its tab
"Changelog". vsce does not rewrite relative links
(`--no-rewrite-relative-links`), so both use full `https://github.com/…`
links.

## Naming

Every extension of the publisher `nimblescape` has a short name `<name>`,
for example `devspaces` or `commentlinks`. The repository and the extension
use it in different forms:

| What | Form | This extension |
| --- | --- | --- |
| Repository | `nimblescape/<name>-vscode` | `nimblescape/devspaces-vscode` |
| `name` in `package.json` | `nimblescape-<name>` | `nimblescape-devspaces-2` |
| Extension ID | `nimblescape.nimblescape-<name>` | `nimblescape.nimblescape-devspaces-2` |
| Package file | `nimblescape-<name>-<version>.vsix` | `nimblescape-devspaces-2-<version>.vsix` |
| Display name | `nimblescape <Title>` | `nimblescape Devspaces 2` |

The organization `nimblescape` is the namespace of the repository, as the
scope `@nimblescape` is the namespace of an npm package, so the name of the
repository does not repeat `nimblescape`. The suffix `-vscode` says that the
repository holds a VS Code extension. When the `name` ends with a number
`-<n>`, the name of the repository leaves the number out: the `name`
`nimblescape-<name>-<n>` has the repository `<name>-vscode`.

The prefix `nimblescape-` keeps the `name` apart from the names of other
publishers, because the Marketplace accepts a `name` only once. The
Marketplace cannot rename an extension ID: another `name` publishes a new
extension, and the old one stays with its installations. An extension that is
no longer wanted is unpublished (More Actions > Unpublish; this can be
undone), never removed: the Marketplace keeps the `name` of a removed
extension reserved permanently, also for its own publisher.

A repository can get a new name. GitHub forwards the links and the clones of
the old name to the repository, as long as no other repository takes the old
name, so a new repository never uses an old name. After a rename, the
publishing needs a new federated credential (see
[Setup of a repository](#setup-of-a-repository)).

## Release

A released version is a tag `v<version>` whose `<version>` equals the version
in `package.json`. The workflow "Release" creates the version, its tag, its
GitHub release and its Marketplace version in one run. To release a version,
follow these steps:

1. Optional: add a section `## <version>` to `CHANGELOG.md` on `main`. The section describes the changes for the users (see [Release rules](#release-rules)).
2. In the tab "Actions", choose the workflow "Release", then "Run workflow" on the branch `main`. Enter the version, for example `0.1.7`. When `CHANGELOG.md` has no section for the version, enter its notes too: they become the section. The GitHub website starts a workflow also in the browser of a phone.

The run has four jobs:

1. "Version commit" checks that the run starts from `main`, that the version has the form `<major>.<minor>.<patch>`, that it is not lower than the version in `package.json` and that its tag does not exist. It sets the version in `package.json` and `package-lock.json`, adds the section of the notes to `CHANGELOG.md` when the file has none, commits the change as "Release `<version>`" and pushes it to the temporary branch `release/run-<run ID>`, not to `main`. When `main` holds the version and its section already, it commits nothing. It also deletes the temporary branches of earlier runs that failed.
2. "CI" runs the workflow `ci.yml` for the commit of the version, because a push with the token of a workflow starts no other workflow. The VSIX that this job tests and builds is the VSIX of the release, so the release repeats no test and no build.
3. "Main, tag and GitHub release" runs only when CI passed. It moves `main` to the commit of the version as a fast-forward and deletes the temporary branch. When `main` changed during the run, it stops before the tag. Then it creates the tag `v<version>` on the commit and the release of the tag with the GitHub CLI `gh`. The section of the version in `CHANGELOG.md` becomes the notes, and the VSIX becomes the file of the release. A release that exists keeps its notes and receives the VSIX only when it holds none.
4. "Publish to the Visual Studio Marketplace" downloads the VSIX of the GitHub release, signs in to Microsoft Entra ID with the official [`azure/login`](https://github.com/Azure/login) action and publishes the VSIX with `vsce publish --azure-credential`.

`main` receives the version commit only after CI passed. When CI fails,
`main`, the tags, the releases and the Marketplace stay unchanged, and the
version can still be released: fix the cause on `main` and start the release
of the same version again. The jobs move and push with the token of the
workflow, so a rule of `main` that blocks direct pushes stops the release.

A dry run tests a release without a change: choose "Dry run" when you start
the workflow. The run makes the version commit on its temporary branch, runs
CI for it and deletes the branch; it changes neither `main`, a tag, a release
nor the Marketplace. Its run name ends with "(dry run)". A dry run may start
from another branch than `main`, so it also tests a change of `release.yml` on
that branch before the change reaches `main`.

When a job fails, remove the cause and choose "Re-run failed jobs" on the
run. A re-run keeps the tag and the VSIX that the GitHub release already
holds, and the Marketplace skips a version that it already holds, so a re-run
never publishes a version twice. When the publish job fails, for example
because the Marketplace refuses the package, the tag and the GitHub release
stay, and the re-run publishes the VSIX of the GitHub release. GitHub allows a
re-run only within 30 days of the run; after that, only a new version can
reach the Marketplace. A new run deletes the temporary branch of a failed run,
so a failed run can no longer be re-run after a new run started.

The Marketplace refuses a package with more than 30 tags, with the error "You
exceeded the number of allowed tags of 30", which the Microsoft publishing
guide names. The tags are the keywords of `package.json` and the tags that
vsce adds, for example the language of each `onLanguage` event in
`activationEvents`; the element `<Tags>` of `extension.vsixmanifest` in the
VSIX lists them. No job counts them before the tag.

The workflows `release.yml` and `marketplace-identity.yml` and this section
are the same in every extension repository of nimblescape. A change to them
goes into every repository.

### Release rules

Every extension of nimblescape follows these rules. No workflow checks them.

1. **The ID never changes.** An extension keeps its ID `nimblescape.nimblescape-<name>` (see [Naming](#naming)), and nimblescape never publishes an extension under a new ID. The only exception is an ID that the Marketplace blocks: the extension then gets the ID `nimblescape.nimblescape-<name>-<n>` with the next free number `<n>`, as Devspaces 2 did.
2. **No deletion.** nimblescape never deletes an extension. No workflow, npm script or file of `scripts/` runs `vsce unpublish`, which deletes the extension on the Marketplace, or `vsce delete-publisher`, which deletes the publisher with all its extensions. On the publisher management page, nobody uses More Actions > Remove, which deletes the extension and keeps its name reserved permanently, or "Delete this version" (More Actions > Reports, tab Manage), after which the number of the version can never be used again. An extension that is no longer wanted is unpublished on the publisher management page, as [Naming](#naming) describes.
3. **Only changes for the users, at most one version in 7 days.** A version is published only when it changes something for the users, its section in `CHANGELOG.md` describes that change, and at least 7 days passed since the newest release; an urgent fix may come earlier. A change for the users changes the extension that VS Code runs: its code (`src/`, which the build bundles into `dist/`), another file of the package that is not a document, for example the icon of a view, or a field of `package.json` that changes how the extension works, for example `contributes`. A change only of the documents (for example the README), the Marketplace icon, the tests or the build tools (for example `esbuild.mjs`, `tsconfig.json` or a file of `scripts/`) does not count: it reaches the users with the next version that changes the extension. Images that only the README shows do not belong in the package: the README links them with full `https://github.com/…` links (see [Manifest](#manifest)). The section of the version in `CHANGELOG.md` does not say "maintenance release", "behaves as in" followed by a version, or a phrase of that kind.
4. **Dry run for a changed release workflow.** A change of `release.yml` is tested with a dry run before a release uses it: start the workflow "Release" with "Dry run" and a version without a tag (with notes when `CHANGELOG.md` has no section for the version), on the branch of the pull request or on `main` before the release. No check enforces this rule, so no pull request waits for a dry run. A change of `ci.yml` needs no dry run: every pull request runs it, and a release runs it before it changes `main`, a tag or a published version, so a failure there changes nothing.
5. **Only GitHub Actions with Microsoft Entra ID.** Only the job "Publish to the Visual Studio Marketplace" publishes, signed in with the app registration of [Marketplace setup](#marketplace-setup). No personal access token exists for the publisher. No other workflow, npm script or file of `scripts/` runs `vsce publish` or `vsce login`. Nobody uploads a VSIX on the publisher management page or runs `vsce publish`, `unpublish`, `delete-publisher` or `login` on a computer.

## Marketplace setup

The workflow publishes with a Microsoft Entra ID token, as the
[Microsoft publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
recommends. It uses no personal access token, because Azure DevOps retires
the global personal access tokens that the Marketplace needs on
1 December 2026. The publishing identity is an app registration with a
federated credential for each repository: GitHub Actions proves the identity
of the job with an OpenID Connect token, so no secret is stored. An app
registration needs no Azure subscription. One app registration publishes
every extension of the publisher `nimblescape`, because the Marketplace
grants the role of a member for the whole publisher.

### What exists

| Part | Where | Value |
| --- | --- | --- |
| Publisher | [Marketplace publisher management](https://marketplace.visualstudio.com/manage) | `nimblescape`, the `publisher` in `package.json` |
| App registration | [Microsoft Entra admin center](https://entra.microsoft.com), "App registrations" | `vscode-marketplace-publisher`, a member of the publisher `nimblescape` with the role "Contributor" |
| Organization variables | GitHub organization `nimblescape`, "Secrets and variables", "Actions", "Variables" | `AZURE_CLIENT_ID` (the application ID of the app) and `AZURE_TENANT_ID` (its directory ID); identifiers, not secrets |
| Federated credential | the app, "Certificates & secrets", "Federated credentials" | one for each repository, named after it |
| Environment | the settings of each repository, "Environments" | `marketplace`, reachable from the tags `v*` and the branch `main` only |

### Setup of a repository

A new extension repository needs its federated credential and its
environment. The script `scripts/marketplace-setup.sh` sets both up for the
GitHub repository of the remote `origin` of the clone, whose name must follow
[Naming](#naming); it needs the Azure CLI, the GitHub CLI and Node.js,
the two CLIs signed in with an account that may change the app registration
and the settings of the repository. It shows what it sets up and
asks before it changes anything. It changes nothing that already exists, so it
can run again:

```sh
az login --allow-no-subscriptions
gh auth login
scripts/marketplace-setup.sh
```

Then run the workflow "Marketplace identity" in the tab "Actions" of the
repository: it signs in like the publish job and prints the member ID of the
app, which shows that the setup works.

The script gives the credential these values. For this repository:

| Field of the federated credential | Value |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:nimblescape@156021698/devspaces-vscode@1434983344:environment:marketplace` |
| Audience | `api://AzureADTokenExchange` |

GitHub puts the owner ID and the repository ID into the subject of every
repository created after 15 July 2026, so a new owner of a reused name gets no
token. The subject also holds the name of the repository: after a rename of
the repository, run the script again. It adds the credential of the new name
and shows the command that deletes the credential of the old name. One app
accepts at most 20 federated credentials.

### Setup from scratch

Only when the publisher, the app or the variables are lost:

1. Create the publisher `nimblescape` on the publisher management page, signed in with the Microsoft account of nimblescape e.U.
2. Register the app `vscode-marketplace-publisher` in the Entra admin center: "New registration", "Single tenant", no API permission, no secret.
3. Set the organization variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` to the application ID and the directory ID of the app. Organization variables reach private repositories only on a paid GitHub plan.
4. Set up a repository with the script, and run its workflow "Marketplace identity".
5. On the publisher management page, open the publisher `nimblescape`, then "Members", and add the member ID that the workflow printed with the role "Contributor".

---

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](LICENSE).
