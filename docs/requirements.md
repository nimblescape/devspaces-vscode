# Requirements

This document lists what nimblescape Devspaces 2 must do. It is the normative text: the [README](../README.md), the [user guide](guide.md), [security.md](security.md), [architecture.md](architecture.md) and [remote-connection.md](remote-connection.md) describe how Devspaces does it today. Each requirement has an ID as its heading, so that code, tests, pull requests and the plan can link to it, for example [`R-ENG-002`](#r-eng-002). The plan of Devspaces is kept outside the repository and names these IDs for each open step.

**Contents:** [General](#general) · [Repositories and devspaces](#repositories-and-devspaces) · [Accounts](#accounts) · [Links](#links) · [Docker engines](#docker-engines) · [The VM of Devspaces](#the-vm-of-devspaces) · [Security](#security) · [Devspaces images](#devspaces-images)

## General

### R-GEN-001

**One click to code.** Devspaces opens a GitHub repository in its own dev container, a devspace, and connects the VS Code window to it. **Start** clones the repository into a Docker volume, builds the image, creates the container and connects the window. Git on the computer of the user is not needed.

### R-GEN-002

**No setup and administrator rights only once.** A student installs only VS Code, and VS Code installs Devspaces and the Dev Containers extension. Devspaces brings everything else that it needs, or sets it up without administrator rights and with as few questions as possible: the Docker CLI ([R-ENG-004](#r-eng-004)) and the VM of Devspaces ([R-VM-001](#r-vm-001)) without a question, and the SSH login ([R-ENG-003](#r-eng-003)) after one confirmation. The same strategy holds on every platform: administrator rights are needed once, for the installation of WSL on Windows and for the installation of QEMU with the access to `/dev/kvm` on Linux, each with one administrator prompt of the system; macOS needs none.

### R-GEN-003

**Platforms.** Devspaces runs in VS Code 1.125 or later (the Microsoft build) on Windows, also Windows Home, on macOS and on Linux, with accounts on github.com. GitHub Enterprise Server and GHE.com are not supported. It works with Docker Engine in its own VM on every platform ([R-VM-001](#r-vm-001)) and with Docker Engine on another computer over SSH ([R-ENG-002](#r-eng-002)), never with the Docker of the computer ([R-ENG-001](#r-eng-001)). Podman is not supported.

### R-GEN-004

**Say what it does.** The top of the README, which is also the page of the extension on the Visual Studio Marketplace, names each behavior of Devspaces on the computer of the user and links to [security.md](security.md): the GitHub sign-in and its scopes, when Devspaces works, Docker and the Dev Containers CLI, the registry logins, the installation of Docker after a confirmation, the SSH key, the VM of Devspaces (WSL 2 or Lima, with the administrator prompt for QEMU on Linux) and its scheduled task, the background container, the Docker context of [R-ENG-007](#r-eng-007) when its setting is on, the downloads and the network connections. A pull request that adds or changes such a behavior changes this list too.

### R-GEN-005

**Release.** The publisher is `nimblescape`, the extension ID is `nimblescape.nimblescape-devspaces-2`, and the display name is "nimblescape Devspaces 2": the display name carries the same number as the ID. A release follows the [release rules](../CONTRIBUTING.md#release-rules) and [Naming](../CONTRIBUTING.md#naming). Nobody publishes a version, creates a version tag or creates a GitHub release until Hannes asks for that release in his own words, and a release dry run needs his yes too. The ID stays. The display name changes only after the Marketplace team approved the new name in writing, and nobody tries a name by publishing it. The display name of the publisher does not change, and `contributes.configuration.title` stays set in `package.json`, so that the title of the settings does not change with the display name.

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

**Fast starts and safe updates.** On each Docker engine, the Monitor container `devspaces-monitor` keeps these up to date in its background run, on the schedule `devspaces.cacheUpdateSchedule` (default every day at 06:07): the images of the devspaces, the next image of each devspace (built in advance), the VS Code Server, the extensions and their dependencies, and the helper image of Devspaces (`devspaces-worker`). The record of the check of the helper image is kept on the engine, and a window checks the helper image only when the Monitor has not done it, so that an open does not rebuild it. Devspaces asks before it updates a devspace to a newer image (`devspaces.updateContainer`), and the files in the workspace are kept. The schedule allows at least 60 minutes between two runs, as a cron expression or as an interval of 60 to 1440 minutes. One check in the code serves the setting, the Monitor and the scheduled task of [R-VM-005](#r-vm-005), so that they cannot differ; an invalid value is reported in the log, and the default is used. On the VM of Devspaces and on the Docker of the computer, the Monitor ends 5 minutes after the last devspace there stopped, but never during its background run or while a retry of that run waits (up to the retry after 30 minutes), and the scheduled task starts it at the times of the schedule. On a remote host, the Monitor runs permanently and ends itself after 30 days without the use of a devspace there; with `devspaces.stopMonitorWhenIdle` (remote hosts only, default off) it ends when idle there too. Devspaces asks no question about the Monitor.

### R-DS-004

**Stops by itself.** A devspace stops 5 minutes after its last window closed, or after `devspaces.stopAfterMinutes` (default 10) without a sign of any window, unless it is kept running: **Keep Running When Closed**, **Close and Keep Running**, or `devspaces.stopOnClose` off.

### R-DS-005

**Back where you left off.** When VS Code restores the window of a devspace, Devspaces opens that devspace. When VS Code starts with an empty window, Devspaces opens a devspace again only when the window that was closed last was connected to it and the user did not stop it.

### R-DS-006

**Dropped: no update of VS Code before a start.** Devspaces does not update VS Code before a devspace starts, because VS Code has no stable API for its updates (only internal commands of its workbench). VS Code installs a waiting update itself, at its next restart. This ID is not used again.

## Accounts

### R-ACC-001

**Several GitHub accounts.** Devspaces uses every GitHub account of VS Code that the user allowed for Devspaces and that has a session with the scopes `repo` and `read:org`, and shows one list for all of them. It opens no sign-in dialog of VS Code without a click of the user, and each call to the sign-in names the account. An account that VS Code has and that Devspaces does not use yet is offered once; after that, only **Add GitHub Account…** offers it.

### R-ACC-002

**The account of a Start.** An existing devspace opens with the account that owns it; when two accounts have a devspace of the same source, the one used last opens. For a new devspace, only the accounts that can access the repository count, and the first of these rules that tells them apart decides: the highest permission (admin, maintain, write, triage, read, then unknown); the account whose login owns the repository; an account that is a member of the organization that owns the repository; the login that comes first in alphabetical order. **Start with Account…** creates a devspace for another account that can access the repository, and the existing devspace stays as it is. The tooltip of a row names the account, and the row of a devspace shows its login when Devspaces uses more than one account.

### R-ACC-003

**One account per devspace.** A devspace belongs to the account that created it. Its container holds only the token of that account, so Git and the GitHub CLI work there as that account. The token leaves the containers of an account when that account leaves Devspaces, and only then. **Remove Devspaces from This Docker Engine…** (the "…" menu of the repository view, the Command Palette, and the menu of each host row of the view "Docker Hosts", [R-ENG-008](#r-eng-008)) names the accounts and removes the devspaces of all accounts of Devspaces on that engine.

## Links

### R-LINK-001

**Open from a link.** A link `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name` opens the devspace of that repository; when Devspaces is not installed, VS Code installs it first. Before a link creates a new devspace, Devspaces asks. For a repository of an account of Devspaces or of one of their organizations, **Always Open** in that question turns it off (setting `devspaces.confirmOpenFromLink`). For other owners, Devspaces always asks. When the user has devspaces of several sources of the repository, the link opens the one used last on the current Docker engine. The devspace opens in the window that VS Code gives the link only when that window is empty; otherwise it opens in a new window.

### R-LINK-002

**Course links.** A link `vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>` opens the own repository of a student of a course. When the user is not signed in, Devspaces asks for the GitHub sign-in first. It puts the login of each account of Devspaces in place of `<username>` and opens the repository that exists with the account of that login, not with the account of the highest permission. When the repositories of two accounts exist, Devspaces asks which one to open. `<username>` may stand anywhere in the name, also more than once; a course link without it gets `-<username>` at the end of the name. For a student who is not a member of the organization of the course, the repository belongs to another owner, so Devspaces always asks before it creates the devspace ([R-LINK-001](#r-link-001)).

## Docker engines

### R-ENG-001

**The Docker of the computer.** Devspaces runs its devspaces in its own VM ([R-VM-001](#r-vm-001)) or on another computer ([R-ENG-002](#r-eng-002)), and never uses the Docker of the computer, on every platform: Docker Desktop and Docker Engine stay installed for the own work of the user, and Devspaces does not use or start them; devspaces that an older version made there are not moved. The choice of the Docker host (the first row of the repository view, or a click on a host row of the view "Docker Hosts", [R-ENG-008](#r-eng-008)) has no entry for the Docker of the computer; it offers the VM of Devspaces, or its setup while the VM does not exist. The view names the VM of Devspaces as the local Docker host, because it runs on the computer. While Devspaces uses its VM and the VM does not exist, for example after its removal outside of Devspaces, the view shows the setup of the VM, as before the first setup, and a link sets the VM up without a question. A computer that cannot run the VM does not meet the precondition of Devspaces, and Devspaces then never uses the Docker of the computer instead, because the devspaces need the isolation of the VM and the same processes on every platform: on a Linux without `/dev/kvm` (no virtualization of the processor), as on a Windows where WSL 2 cannot start its virtual machine ([R-ENG-005](#r-eng-005)), the view says why the computer cannot run devspaces and offers a remote host ([R-ENG-002](#r-eng-002)).

### R-ENG-002

**A remote host over SSH with one login.** Devspaces runs devspaces on Docker Engine on another computer that it reaches over SSH. It keeps its own list of hosts and never changes the current Docker context or `DOCKER_HOST`, so the Docker tools in the terminals of the user keep their target; only the setting of [R-ENG-007](#r-eng-007) creates a Docker context, and never for a remote host. Each window logs in to a host once (after a **Start**, VS Code starts the window again, and it logs in once more): the checks before the connection, the worker, the Docker connections of the Dev Containers extension and the Docker calls of Devspaces use that one login. A build of the helper image in the background waits for that connection and runs through it, without a login of its own. One exception is allowed: when the current helper image is missing on the host, for example at the first use of the host or after an update of Devspaces that changes the helper image, the open of a window builds it with one SSH login of its own before the login of the window, because the connection runs that image. This happens once per host and version of the helper image. The host needs only an SSH server, Docker Engine that the account may use, and `sh`; Devspaces never installs or starts Docker there. A remote host serves one user, or a group whose members trust each other; the separation of students on one shared host is not a requirement now.

### R-ENG-003

**SSH logins without setup.** Devspaces uses the `ssh` of the computer, so the SSH config, `ProxyJump` and existing keys work. The user sets up nothing for Devspaces: no `ControlMaster`, no `MaxStartups` and no SSH agent. In a flow that the user started, each question of the login (an unknown host key with its fingerprint, a password, a passphrase or a code) appears in VS Code; the work in the background asks nothing. Devspaces keeps no answer, and keeps a host key only after the user accepted its fingerprint. After a login with a password, Devspaces offers once to create its own key `~/.ssh/devspaces_ed25519` without a passphrase and to add it to `authorized_keys` on the host. It never writes over another file in `~/.ssh` and never changes the SSH config.

### R-ENG-004

**The Docker CLI of Devspaces.** A computer needs no Docker. The window of a devspace in the VM of Devspaces or on another computer, and the Docker calls of Devspaces there, use a Docker CLI that Devspaces downloads from `download.docker.com` and checks against the size and the SHA-256 that its code pins. A daily workflow proposes a new pin as a pull request. Before a window of a devspace opens, Devspaces compares the Docker API versions of that CLI with those of the engine (`ApiVersion` and `MinAPIVersion`), and when they do not fit, it says so with both versions and what to do. When the download is not possible, the window uses the Docker CLI of the computer and says so.

### R-ENG-005

**Windows: the WSL distribution of Devspaces.** On Windows, the VM of Devspaces ([R-VM-001](#r-vm-001)) is its own WSL 2 distribution `devspaces`, also on a Windows with Docker Desktop ([R-VM-008](#r-vm-008)). The Docker setup of the view and a link ([R-LINK-001](#r-link-001)) check WSL and install WSL 2 first when it is missing, without a question of Devspaces (Windows asks for administrator permission); after the restart of Windows, the first window goes on with the setup, and with the link, by itself. Then Devspaces sets up the distribution, without a question and without administrator rights, from the `.wsl` file of its own image ([R-VM-002](#r-vm-002)) for the architecture of Windows, and uses it as a host through `wsl.exe`, without SSH, with the Docker CLI of Devspaces ([R-ENG-004](#r-eng-004)). The setup shows its progress, also of the download, and says before the download when WSL 2 cannot start its virtual machine (no restart after the installation of WSL, or no virtualization); a download that WSL could not register stays for the next setup. Devspaces starts the distribution again when WSL runs out of time to start it, which happens in a slow virtual machine. A link uses a distribution that Devspaces set up before as it is, and a distribution of an older version is not converted. The distribution is never the default distribution of WSL, and a distribution with that name that the user made is never changed or removed. Devspaces never writes `.wslconfig`, and removes the distribution only after a question.

### R-ENG-006

**The same processes on every engine.** Once a Linux system with Docker Engine is there, Devspaces runs the same processes on every engine: its Lima VM, its WSL distribution ([R-ENG-005](#r-eng-005)), and a remote host over SSH ([R-ENG-002](#r-eng-002)). Only the transport to the engine differs: the SSH of Lima to its VM (with the key that Lima made, as root, without a login of the user), `wsl.exe`, or the SSH login. No engine gets a build, a check or a tool of its own. The management of the VM of Devspaces ([R-VM-001](#r-vm-001)) is the one exception. So the helper image is built in a container on the engine with buildx (BuildKit) from a build image that Devspaces pins by its digest, whatever Docker CLI sends the calls.

### R-ENG-007

**Other Docker tools.** By default, Devspaces creates no Docker context, so the Dev Containers extension, the Container Tools extension and the `docker` command see no container, image or volume of the VM of Devspaces. The setting `devspaces.createDockerContext` (scope `machine`, default off) creates the Docker context `devspaces` for the engine of the VM; it never becomes the current context, and turning the setting off removes it. On macOS and Linux it points to the Docker socket of the Lima VM; on Windows it points to a named pipe of Devspaces and works only while a window of Devspaces is open. A Docker context gives full access, so the guide says to manage devspaces only with Devspaces: a deleted volume deletes unpushed work, and a container that another tool created has no labels and records of Devspaces. The view "Docker Hosts" ([R-ENG-008](#r-eng-008)) shows and removes the objects of Devspaces in the VM without a Docker context, and the guide names it as the tool for them.

### R-ENG-008

**The view "Docker Hosts".** A view "Docker Hosts" below the repository view lists the Docker hosts of Devspaces: the VM of Devspaces first, also before its setup ([R-VM-010](#r-vm-010)), then each remote host of the list of Devspaces. Other Lima VMs and WSL distributions of the user are never shown. Under each host, it shows the containers, images and volumes of Devspaces there: those with a label `nimblescape.devspaces.*`, the containers and volumes whose name starts with `devspaces-`, the build image that Devspaces pins, and the base images that the build records of the devspaces of this computer name; every other object of the engine stays hidden. Each row says the purpose of its object (a devspace with its repository, the Monitor, a worker, a batch helper, the helper image, a shared volume, and so on) and its size, and each group the sum of its sizes, from one `docker system df -v` per read. Devspaces reads a host only when the user opens it in the view or clicks Refresh, never in the background, and never starts the VM for a read: a stopped VM shows a row that starts it. Opening a remote host is a flow that the user started, so a password login may ask there ([R-ENG-003](#r-eng-003)). The objects of a devspace of this computer get the commands of the devspace: Stop, and Delete…, which checks the Git changes first. Every other object gets **Remove…**, after one question that names the objects, also for several selected rows; a running container gets **Stop** first. Devspaces never removes with force, so Docker keeps an image or a volume that a container uses. A click on a host row makes it the Docker host of Devspaces after its test, and a check mark shows it; the repository view and **Start** use the selected host, as before, and the first row of the repository view stays. The menu of a host row has **Update All Images Now**, **Remove Devspaces from This Docker Engine…** ([R-ACC-003](#r-acc-003)) and, for a remote host, **Remove from the List**; the **+** in the title of the view adds a remote host.

## The VM of Devspaces

### R-VM-001

**One Linux in a light VM on every platform.** Devspaces runs its devspaces in its own virtual machine: WSL 2 on Windows, also Windows Home ([R-ENG-005](#r-eng-005)), and [Lima](https://lima-vm.io) on macOS (Apple Virtualization) and on Linux (QEMU with KVM). Every VM runs the same image ([R-VM-002](#r-vm-002)) with Docker Engine; only the management of the VM differs: create, start, stop when idle, upgrade, remove, and the command that runs a program in the VM (`wsl.exe`, or `ssh` with the SSH configuration that Lima wrote for the VM). Devspaces downloads a Lima that its code pins by version and SHA-256 into a folder of the user, so macOS needs no administrator rights; on Linux, one administrator prompt installs QEMU and gives the user access to `/dev/kvm` ([R-GEN-002](#r-gen-002)). Devspaces never starts a VM with an emulated processor and never uses the Docker of a Linux without `/dev/kvm` instead: that computer does not meet the precondition, as on Windows ([R-ENG-001](#r-eng-001)). Devspaces creates the VM only for the first devspace, and the devspaces live on the disk of the VM.

### R-VM-002

**The image of the VM.** Devspaces builds one Debian 13 image of its own, as a `.wsl` file for WSL and as a disk for Lima, for amd64 and arm64, from one recipe: systemd, cloud-init, Docker Engine from the packages of Docker (`docker-ce`, `docker-ce-cli` and `containerd.io`), and the scripts of Devspaces. The files differ only in the kernel: WSL always runs the kernel of Microsoft. The files are an OCI package of the nimblescape organization on `ghcr.io`; Devspaces downloads them over HTTPS, without a Docker CLI, and checks the SHA-256 that its code pins. A daily workflow builds and tests the image every day, and pushes it and opens a pull request with the new pins only when the list of its packages changed. `ghcr.io` keeps every version that a published release of Devspaces pins, and the newest 5.

### R-VM-003

**Kernel check.** The kernel features that Docker Engine requires (the list "Generally Necessary" of Docker's `contrib/check-config.sh`) are checked in two places: in the daily workflow of the image, against the configuration of the Debian kernel of the image and against the configuration of the WSL kernel that Microsoft publishes, for amd64 and arm64, where a missing feature stops the pull request; and in the VM, at each start where the kernel version changed since the last check. Only a missing feature shows a message, with the missing features in the log.

### R-VM-004

**Stop when idle.** One idle script in the VM, the same in WSL and in Lima, checks every minute whether a devspace, the Monitor, a worker, a build container or the package upgrade ([R-VM-007](#r-vm-007)) runs, or whether a program is connected to Docker Engine (for example while it downloads an image before the first container), and stops the VM after two checks in a row with nothing running. On Windows, one hidden `wsl.exe` that is not a child of VS Code runs the script, and WSL stops the distribution when the script ends; in Lima, a systemd service runs it and powers the VM off. No other process on the computer keeps the VM running.

### R-VM-005

**Start at the update schedule.** A task of the user (Task Scheduler on Windows, without administrator rights; a launch agent on macOS; a systemd user timer on Linux) starts the VM of Devspaces, when there is one, and then the Monitor ([R-DS-003](#r-ds-003)) at the times of `devspaces.cacheUpdateSchedule`, in the time zone of the computer, and gives the Monitor the current schedule and time zone at each start. The task starts the VM 5 minutes after a time of the schedule. A time that the computer missed because it slept or was off runs once after the wake or the login, also on battery: on macOS and Linux 5 minutes after it, where an agent at login starts the VM only when a time was missed; on Windows 10 minutes after it, the wait of Task Scheduler for a time that was missed, and the task may run on battery and has no time limit. Devspaces never wakes the computer. When the setting changes, Devspaces writes the task again. Apart from this catch-up, nothing starts at login, and Devspaces asks no question about the Monitor; when a window is open at that time, the VM and the Monitor run already, and the task changes nothing.

### R-VM-006

**Memory and CPUs.** The Lima VM gets 4 GiB of memory and 4 CPUs by default, each at most half of the computer, and at least 1 CPU. The settings `devspaces.vmMemoryGiB` and `devspaces.vmCpus` (scope `machine`) change them for the next start of the VM; their description says "macOS and Linux only. On Windows, manage it via WSL.", and Devspaces ignores them on Windows. When the kernel of the VM ends a process because the memory ran out, Devspaces says so and names the memory setting.

### R-VM-007

**Updates.** The VM upgrades its packages itself (`apt-get upgrade`), at each start when the last upgrade that ended well is 20 hours old, and tries a failed one again after 6 hours, without a restart of Docker or of the running devspaces; the idle script waits for it. A new major release of Debian is installed in place by an upgrade script of Devspaces that CI tests: the VM is never replaced, because the devspaces live on its disk. Everything that Devspaces pins in its code (the image, Lima, the Docker CLI, the build image, and the Node.js version of the build) is checked every day by the workflow "Daily checks", which opens a pull request only for a new version; a new pin reaches the users with the next release. WSL and its kernel come from Microsoft.

### R-VM-008

**Windows with Docker Desktop.** WSL runs the distribution of Devspaces and that of Docker Desktop in one VM with one network stack. Devspaces uses its own distribution also on a Windows with Docker Desktop, and never Docker Desktop. A manual test on such a computer ([manual-tests.md](manual-tests.md)) checks that both run side by side, without a clash of ports or Docker sockets.

### R-VM-009

**Tests.** CI tests the VM where the runners of GitHub allow it: on Linux with KVM, the start of the image, the scheduled task with a time in the past, the update of the Monitor and the stop by the idle script after it, and the state, the stop and the removal of the VM of [R-VM-010](#r-vm-010). The runners of Windows have no WSL 2 and those of macOS no nested virtualization, so each step that changes the VM on Windows or macOS has a written list of manual tests ([manual-tests.md](manual-tests.md)).

### R-VM-010

**Manage the VM.** The row of the VM of Devspaces in the view "Docker Hosts" ([R-ENG-008](#r-eng-008)) shows its state (Not set up, Stopped or Running), which Devspaces reads without a start of the VM and without a download, and in its tooltip the memory and the CPUs of the VM (Lima) and the space of its disk on the computer. Its menu has the same commands on every platform: **Set Up** while there is no VM; **Start the VM**, the test of the host, which starts the VM without a change of the Docker host of Devspaces (the VM powers itself off again by [R-VM-004](#r-vm-004)); **Stop the VM…** (`limactl stop`, or `wsl --terminate devspaces`), which asks first while devspaces run there and names them; **Remove the VM…** (`limactl delete`, or `wsl --unregister devspaces`) and **Remove and Set Up the VM Again…**, each after a question, because they delete every devspace in the VM; and **Settings of the VM**, its memory and CPUs ([R-VM-006](#r-vm-006), macOS and Linux). Before a stop or a removal, the connections of the window to the VM end. A Docker call to a VM that does not run, also to read its running devspaces, waits for a command of the user that starts it.

## Security

### R-SEC-001

**Host access checks.** Before a container is created, and again before `up`, Devspaces checks the final configuration and refuses what reaches into the computer or into another devspace (see [Host access checks](security.md#host-access-checks)). The user can turn off the checks of the first list for one repository, only in the user settings; the second list stays refused.

### R-SEC-002

**Token and registry logins.** Devspaces stores no token on the computer, and the GitHub token of the owner account is only in the memory of the container. Devspaces checks and pulls images and Features first without a login. It uses a registry login that Docker stored only when the registry refuses, does not find the image, or limits pulls without a login, only for that one check or pull, and never stores it. For `ghcr.io` without such a login, it uses the GitHub sign-in of the owner account of the devspace with the scope `read:packages`.

### R-SEC-003

**Docker pipes with an allow-list.** The Docker pipe of a window and the Docker pipe of the extension let through only the Docker requests on their allow-list and refuse every other request (see [The request filter](remote-connection.md#the-request-filter)). The allow-list of the extension has `POST /containers/<id>/stop` for the **Stop** of a container in the view "Docker Hosts" ([R-ENG-008](#r-eng-008)). The named pipe of the Docker context of [R-ENG-007](#r-eng-007) on Windows has no allow-list, because a Docker context gives full access. Only the user of the computer can open them.

### R-SEC-004

**Quiet and private.** Before the first devspace, Devspaces does no Docker work and creates no VM: it only reads its Docker host. The view "Docker Hosts" ([R-ENG-008](#r-eng-008)) reads a host only when the user opens it or clicks Refresh, and never starts the VM for a read. Devspaces collects no telemetry. In Restricted Mode, and for the settings that the guide marks *user only*, only the user settings count.

## Devspaces images

The dev container images of the courses are built in the repositories `majikmate/devcontainer-*` and published on `ghcr.io/majikmate`.

### R-IMG-001

**Releases.** Every image is built by the shared workflow `devcontainer-image.yml` of [devcontainer-core](https://github.com/majikmate/devcontainer-core). A nightly check in UTC releases a new image when an input changed or the newest image has pending Debian updates, and a new image of a lower layer releases the images above it in the same night. `ghcr.io` keeps the newest 5 releases of each image, and workflow runs older than 30 days are deleted.

### R-IMG-002

**Prompt.** The shell prompt in a devspace shows no `user@host`, as in a GitHub Codespace. Devspaces never sets the variable `CODESPACES`.

### R-IMG-003

**nimblescape extensions.** The image of devcontainer-base installs nimblescape PlantUML (in place of the PlantUML extension of jebbs), nimblescape Mindbug and nimblescape Comment Links. When the course extension of nimblescape Markdown is published, the image of devcontainer-classroom-web installs it too.
