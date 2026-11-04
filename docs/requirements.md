# Requirements

This document lists what nimblescape Devspaces 2 must do. It is the normative text: the [README](../README.md), the [user guide](guide.md), [security.md](security.md), [architecture.md](architecture.md) and [remote-connection.md](remote-connection.md) describe how Devspaces does it today. Each requirement has an ID as its heading, so that code, tests, pull requests and the plan can link to it, for example [`R-ENG-002`](#r-eng-002). The plan of Devspaces is kept outside the repository and names these IDs for each open step.

**Contents:** [General](#general) · [Repositories and devspaces](#repositories-and-devspaces) · [Accounts](#accounts) · [Links](#links) · [Docker engines](#docker-engines) · [Security](#security) · [Devspaces images](#devspaces-images)

## General

### R-GEN-001

**One click to code.** Devspaces opens a GitHub repository in its own dev container, a devspace, and connects the VS Code window to it. **Start** clones the repository into a Docker volume, builds the image, creates the container and connects the window. Git on the computer of the user is not needed.

### R-GEN-002

**No setup and no administrator rights.** A student installs only VS Code, and VS Code installs Devspaces and the Dev Containers extension. Devspaces brings everything else that it needs, or sets it up after one confirmation, without administrator rights: the Docker CLI ([R-ENG-004](#r-eng-004)), the WSL distribution on Windows ([R-ENG-005](#r-eng-005)) and the SSH login ([R-ENG-003](#r-eng-003)). Only the installation of WSL itself and the installation of Docker, when the user chooses it ([R-ENG-001](#r-eng-001)), need administrator rights.

### R-GEN-003

**Platforms.** Devspaces runs in VS Code 1.125 or later (the Microsoft build) on Windows, macOS and Linux, with accounts on github.com. GitHub Enterprise Server and GHE.com are not supported. It works with Docker Desktop, with Docker Engine on Linux, with Docker Engine on another computer over SSH ([R-ENG-002](#r-eng-002)), and on Windows with Docker Engine in its own WSL distribution ([R-ENG-005](#r-eng-005)). Podman is not supported.

### R-GEN-004

**Say what it does.** The top of the README, which is also the page of the extension on the Visual Studio Marketplace, names each behavior of Devspaces on the computer of the user and links to [security.md](security.md): the GitHub sign-in and its scopes, when Devspaces works, Docker and the Dev Containers CLI, the registry logins, the installation of Docker after a confirmation, the SSH key, the WSL distribution with its start entry, the background container, the downloads and the network connections. A pull request that adds or changes such a behavior changes this list too.

### R-GEN-005

**Release.** The publisher is `nimblescape`, the extension ID is `nimblescape.nimblescape-devspaces-2`, and the display name is "nimblescape Devspaces 2": the display name carries the same number as the ID. A release follows the [release rules](../CONTRIBUTING.md#release-rules) and [Naming](../CONTRIBUTING.md#naming). Nobody publishes a version, creates a version tag or creates a GitHub release until Hannes asks for that release in his own words, and a release dry run needs his yes too. The ID stays. The display name changes only after the Marketplace team approved the new name in writing, and nobody tries a name by publishing it.

### R-GEN-006

**Development rules.**

- TypeScript 6.0.3, exact, and ESLint with the shared `eslint.config.mjs`; `npm run lint` runs in CI after the type check. These are the same in every nimblescape extension, and a move to another TypeScript version is one decision for all extensions together.
- The Node.js version is only in `.node-version`, on the major version of the Node.js of VS Code.
- CI builds and tests every change of the code on Linux, Windows and macOS. A change of documents only (`docs/` and Markdown files) runs no CI.
- Every pull request is reviewed in rounds until a round finds nothing serious, and is merged with a squash merge when CI passes. Nobody force-pushes, and nobody removes the work of others.
- The npm scripts `install-local` and `uninstall-local` install and remove the packaged extension in the local VS Code, as in every nimblescape extension.

### R-GEN-007

**Documents.** The documents use plain English for readers whose first language is not English: short sentences, no slang, no metaphors and no analogies. Every reference to a file, a line, an issue or a pull request is a link. The documents describe the code on `main`, and a pull request that changes a behavior changes the documents in the same pull request.

## Repositories and devspaces

### R-DS-001

**The list.** The view lists the repositories of the GitHub accounts of Devspaces ([R-ACC-001](#r-acc-001)) that have a Dev Container configuration (`.devcontainer/devcontainer.json`, `.devcontainer.json`, or `.devcontainer/<folder>/devcontainer.json`), grouped by owner. The settings `devspaces.owners` and `devspaces.repositoryGroups` limit and group the list. Each window reads the list when it opens and then every hour by default; a refresh reads only the repositories that changed.

### R-DS-002

**Sources and the default image.** With `devspaces.defaultImage` set, every repository can start from that image, also a repository without a Dev Container configuration. Each source of a repository (each configuration, and the default image) is a devspace of its own, with its own row under the repository, and all sources can run at the same time. `devspaces.startWithDefaultImage` decides whether the default image is the first or the last source.

### R-DS-003

**Fast starts and safe updates.** On each Docker engine, the Monitor container `devspaces-monitor` keeps these up to date in its background run, on the schedule `devspaces.cacheUpdateSchedule` (default every day at 06:07): the images of the devspaces, the next image of each devspace (built in advance), the VS Code Server, the extensions and their dependencies, and the helper image of Devspaces (`devspaces-worker`). The record of the check of the helper image is kept on the engine, and a window checks the helper image only when the Monitor has not done it, so that an open does not rebuild it. Devspaces asks before it updates a devspace to a newer image (`devspaces.updateContainer`), and the files in the workspace are kept. The first start on an engine asks whether the Monitor keeps running while VS Code is closed or stops when idle; a Monitor that keeps running ends itself after 30 days without the use of a devspace on that engine.

### R-DS-004

**Stops by itself.** A devspace stops 5 minutes after its last window closed, or after `devspaces.stopAfterMinutes` (default 10) without a sign of any window, unless it is kept running: **Keep Running When Closed**, **Close and Keep Running**, or `devspaces.stopOnClose` off.

### R-DS-005

**Back where you left off.** When VS Code restores the window of a devspace, Devspaces opens that devspace. When VS Code starts with an empty window, Devspaces opens a devspace again only when the window that was closed last was connected to it and the user did not stop it.

## Accounts

### R-ACC-001

**Several GitHub accounts.** Devspaces uses every GitHub account of VS Code that the user allowed for Devspaces and that has a session with the scopes `repo` and `read:org`, and shows one list for all of them. It opens no sign-in dialog of VS Code without a click of the user, and each call to the sign-in names the account. An account that VS Code has and that Devspaces does not use yet is offered once; after that, only **Add GitHub Account…** offers it.

### R-ACC-002

**The account of a Start.** An existing devspace opens with the account that owns it; when two accounts have a devspace of the same source, the one used last opens. For a new devspace, only the accounts that can access the repository count, and the first of these rules that tells them apart decides: the highest permission (admin, maintain, write, triage, read, then unknown); the account whose login owns the repository; an account that is a member of the organization that owns the repository; the login that comes first in alphabetical order. **Start with Account…** creates a devspace for another account that can access the repository, and the existing devspace stays as it is. The tooltip of a row names the account, and the row of a devspace shows its login when Devspaces uses more than one account.

### R-ACC-003

**One account per devspace.** A devspace belongs to the account that created it. Its container holds only the token of that account, so Git and the GitHub CLI work there as that account. The token leaves the containers of an account when that account leaves Devspaces, and only then. **Remove Devspaces from This Docker Engine…** names the accounts and removes the devspaces of all accounts of Devspaces on that engine.

## Links

### R-LINK-001

**Open from a link.** A link `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name` opens the devspace of that repository; when Devspaces is not installed, VS Code installs it first. Before a link creates a new devspace, Devspaces asks. For a repository of an account of Devspaces or of one of their organizations, **Always Open** in that question turns it off (setting `devspaces.confirmOpenFromLink`). For other owners, Devspaces always asks.

### R-LINK-002

**Course links.** A link `vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>` opens the own repository of a student of a course. When the user is not signed in, Devspaces asks for the GitHub sign-in first. It puts the login of each account of Devspaces in place of `<username>` and opens the repository that exists with the account of that login, not with the account of the highest permission. When the repositories of two accounts exist, Devspaces asks which one to open.

## Docker engines

### R-ENG-001

**Local Docker and its setup.** Devspaces uses the Docker of the computer: Docker Desktop on Windows (also the installation for one user in `%LOCALAPPDATA%`), on macOS and on Linux, or Docker Engine on Linux. When Docker is missing, the view offers its installation, a remote host ([R-ENG-002](#r-eng-002)) and, on Windows, the WSL distribution of Devspaces ([R-ENG-005](#r-eng-005)). Devspaces first shows the exact commands, or the download address of the installer, and runs them only after the user confirms, in a terminal of VS Code that the user sees.

### R-ENG-002

**A remote host over SSH with one login.** Devspaces runs devspaces on Docker Engine on another computer that it reaches over SSH. It keeps its own list of hosts and never creates or changes a Docker context or `DOCKER_HOST`, so the Docker tools in the terminals of the user keep their target. Each window logs in to a host once (after a **Start**, VS Code starts the window again, and it logs in once more): the checks before the connection, the worker, the Docker connections of the Dev Containers extension and the Docker calls of Devspaces use that one login. A build of the helper image in the background waits for that connection and runs through it, without a login of its own. The host needs only an SSH server, Docker Engine that the account may use, and `sh`; Devspaces never installs or starts Docker there. A remote host serves one user, or a group whose members trust each other; the separation of students on one shared host is not a requirement now.

### R-ENG-003

**SSH logins without setup.** Devspaces uses the `ssh` of the computer, so the SSH config, `ProxyJump` and existing keys work. The user sets up nothing for Devspaces: no `ControlMaster`, no `MaxStartups` and no SSH agent. In a flow that the user started, each question of the login (an unknown host key with its fingerprint, a password, a passphrase or a code) appears in VS Code; the work in the background asks nothing. Devspaces keeps no answer, and keeps a host key only after the user accepted its fingerprint. After a login with a password, Devspaces offers once to create its own key `~/.ssh/devspaces_ed25519` without a passphrase and to add it to `authorized_keys` on the host. It never writes over another file in `~/.ssh` and never changes the SSH config.

### R-ENG-004

**The Docker CLI of Devspaces.** A computer needs no Docker to use a remote host. The window of a devspace on another computer, and the Docker calls of Devspaces there, use a Docker CLI that Devspaces downloads from `download.docker.com` and checks against the size and the SHA-256 that its code pins. A weekly workflow proposes a new pin as a pull request. Before a window of a devspace opens, Devspaces compares the Docker API versions of that CLI with those of the engine (`ApiVersion` and `MinAPIVersion`), and when they do not fit, it says so with both versions and what to do. When the download is not possible, the window uses the Docker CLI of the computer and says so.

### R-ENG-005

**Windows without Docker Desktop.** On Windows, Devspaces sets up, after one confirmation and without administrator rights, its own WSL 2 distribution `devspaces` from the Debian file of the list of WSL distributions of Microsoft (checked against its SHA-256), with Docker Engine, and uses it as a host of its list through `wsl.exe`, without SSH. The distribution is never the default distribution of WSL, and a distribution with that name that the user made is never changed or removed. It runs while a window, a devspace or the Monitor needs it, and stops when nothing needs it; after **Keep Running** for its Monitor, a start entry of the Windows user starts it at logon. Devspaces upgrades its packages about once a week without stopping the running devspaces, and removes the distribution only after a question.

## Security

### R-SEC-001

**Host access checks.** Before a container is created, and again before `up`, Devspaces checks the final configuration and refuses what reaches into the computer or into another devspace (see [Host access checks](security.md#host-access-checks)). The user can turn off the checks of the first list for one repository, only in the user settings; the second list stays refused.

### R-SEC-002

**Token and registry logins.** Devspaces stores no token on the computer, and the GitHub token of the owner account is only in the memory of the container. Devspaces checks and pulls images and Features first without a login. It uses a registry login that Docker stored only when the registry refuses, does not find the image, or limits pulls without a login, only for that one check or pull, and never stores it. For `ghcr.io` without such a login, it uses the GitHub sign-in of the owner account of the devspace with the scope `read:packages`.

### R-SEC-003

**Docker pipes with an allow-list.** The Docker pipe of a window and the Docker pipe of the extension let through only the Docker requests on their allow-list and refuse every other request (see [The request filter](remote-connection.md#the-request-filter)). Only the user of the computer can open them.

### R-SEC-004

**Quiet and private.** Before the first devspace, Devspaces does no Docker work: it only reads its Docker host and the current Docker context. Devspaces collects no telemetry. In Restricted Mode, and for the settings that the guide marks *user only*, only the user settings count.

## Devspaces images

The dev container images of the courses are built in the repositories `majikmate/devcontainer-*` and published on `ghcr.io/majikmate`.

### R-IMG-001

**Releases.** Every image is built by the shared workflow `devcontainer-image.yml` of [devcontainer-core](https://github.com/majikmate/devcontainer-core). A nightly check in UTC releases a new image when an input changed or the newest image has pending Debian updates, and a new image of a lower layer releases the images above it in the same night. `ghcr.io` keeps the newest 5 releases of each image, and workflow runs older than 30 days are deleted.

### R-IMG-002

**Prompt.** The shell prompt in a devspace shows no `user@host`, as in a GitHub Codespace. Devspaces never sets the variable `CODESPACES`.

### R-IMG-003

**nimblescape extensions.** The image of devcontainer-base installs nimblescape PlantUML (in place of the PlantUML extension of jebbs), nimblescape Mindbug and nimblescape Comment Links.
