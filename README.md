# nimblescape Devspaces 2

Open your GitHub repositories in dev containers with one click, on your own Docker.

Devspaces lists the GitHub repositories that you can access and that have a Dev Container configuration. **Start** opens a repository in its own dev container, a **devspace**, and connects the VS Code window to it. The containers run in a VM of Devspaces on your computer, or on Docker on another computer that you reach over SSH.

![nimblescape Devspaces 2 in VS Code, in six scenes: after the sign-in with GitHub, the view lists the repositories that have a Dev Container configuration; a double-click starts the devspace of school/web-basics on the remote host school-server, and the window connects to its container; the view Docker Hosts shows the containers, volumes and networks of the host; a click on a volume and on the devspace container opens their reports in a preview tab, and a double-click keeps the tab; the report of the Monitor lists its last runs, and Show Log of the Monitor opens its log; Show Utilization shows the CPU, memory and disk use of the host; a blue band above the window names each scene](https://raw.githubusercontent.com/nimblescape/devspaces-vscode/main/docs/images/devspaces.gif)

## What Devspaces does on your computer

- **GitHub sign-in.** Devspaces uses the GitHub sign-in of VS Code with the scopes `repo` (read and change the repositories that you can access, also the private ones) and `read:org` (read your organization memberships), and with `read:packages` only for a private image on `ghcr.io`. VS Code keeps the sign-ins, and Devspaces saves no token. At each open, Devspaces writes the token of the account that owns the devspace into the memory of its container, so that Git works there; code in that container can use it.
- **When it works.** Devspaces starts with every VS Code window.
  - Before your first devspace, Devspaces only reads its Docker host when VS Code starts. It never reads the Docker context of this computer, because it never uses the Docker of this computer.
  - After your first devspace, a window also checks the Docker engine when it starts, and reads the state of your devspaces while the view is visible.
  - When the window that you closed last was connected to a devspace, the next start of VS Code opens that devspace again. When VS Code restores the window of a devspace, Devspaces opens that devspace first.
  - Each window reads your repository list from GitHub when it opens, and then every hour by default.
  - A link `vscode://nimblescape.nimblescape-devspaces-2/open?repository=owner/name` opens your devspace of that repository after VS Code asks, unless you chose "Do not ask me again for this extension". A course link `vscode://nimblescape.nimblescape-devspaces-2/course?repository=owner/name-<username>` first asks for the GitHub sign-in if you are not signed in, and puts the login of each of your accounts in place of `<username>`.
  - With the VM or the WSL distribution of Devspaces, a scheduled task of your user starts it for the background updates (daily at 06:07 by default), also while VS Code is closed. It never wakes the computer.
- **Docker and the Dev Containers CLI.** Devspaces runs the Docker CLI on your computer, and `ssh` for a Docker host on another computer. Its helper containers clone your repositories into Docker volumes, and build, create, start, stop and remove the containers of your devspaces with the Docker Engine API and the Dev Containers CLI. Devspaces never changes the current Docker context, so the Docker tools in your terminals keep their target; only the setting `devspaces.createDockerContext` (off by default) creates the context `devspaces`.
- **Registry logins.** Devspaces pulls an image first without a login. Only when the registry refuses this, does not find the image, or limits pulls without a login, it uses the login that Docker stored on your computer (`~/.docker/config.json` and its `docker-credential-*` helpers) for that one pull, and never stores it.
- **Docker installation.** **Set Up Docker for Devspaces** installs Docker Engine in a VM of Devspaces, after your click or when you open a link to Devspaces without it: a Lima VM on macOS and Linux, a WSL distribution on Windows. When QEMU (Linux) or WSL 2 (Windows) is missing, it installs it first, in a terminal of VS Code that you see. Devspaces never installs, starts or uses Docker Desktop or the Docker Engine of your computer.
- **Background container.** On each Docker engine, the container `devspaces-monitor` keeps the images of your devspaces, the VS Code Server and your extensions up to date, builds the next image of a devspace in advance (Docker runs the Dockerfile and the Features of the repository), removes old versions that no container uses, and stops a devspace a few minutes after its last window closes, unless you keep it running. To add a newer VS Code Server to a running devspace, it runs a command there, as `docker exec` does. On a remote host, this container keeps running, also while VS Code is closed; on the VM or the WSL distribution of Devspaces, it stops 5 minutes after the last devspace stopped. Devspaces asks no question about it. It ends itself after 30 days without a devspace on that engine, and **Devspaces: Remove Devspaces from This Docker Engine…** removes it.
- **The view Docker Hosts.** The view reads the objects of a host only when you open the host or click **Refresh**, and a report only when you click an object; for a shared volume of Devspaces, one short-lived container without network reads what it holds. It removes an object only after your click and one question. The utilization page reads only while it is visible.
- **SSH key.** Only after **Use a Key** in its question, Devspaces creates the key `~/.ssh/devspaces_ed25519` on your computer and adds its public key to `~/.ssh/authorized_keys` of your account on the remote host.
- **Network.** Devspaces connects to GitHub, to your remote Docker hosts over SSH, to the image registries of your Dev Container configurations, to the update service of VS Code, to the Visual Studio Marketplace, and to Docker Hub, Debian and npm for its helper image. It downloads the image of its VM, Lima and a Docker CLI, each checked against the SHA-256 in its code. It collects no telemetry. The code in a devspace can connect to any address.
- **Restricted Mode and virtual workspaces.** Devspaces works in Restricted Mode, where only your user settings count for its settings, and in virtual workspaces.

A repository that you open is code that you run: open only repositories that you trust. [Security](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/security.md#what-devspaces-does-on-your-computer) describes each step and where its protection ends.

## Features

- **One click to code.** **Start** clones the repository into a Docker volume, builds the image, creates the container and connects the window. Git on your computer is not needed.
- **Fast starts.** The Monitor prepares newer images, the VS Code Server and your extensions in the background.
- **Safe updates.** When a newer image is available, Devspaces tells you before it updates the container. Your files in the workspace are kept.
- **Stops by itself.** A devspace stops 5 minutes after its last window closes, unless you keep it running.
- **Open from a link.** A link on a website opens a repository in its devspace, and a course link opens the own repository of each student ([Open from a link](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/guide.md#open-from-a-link)).
- **Several GitHub accounts.** One list for all GitHub accounts of VS Code that you use in Devspaces ([Several GitHub accounts](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/guide.md#several-github-accounts)).
- **Remote Docker.** Run your devspaces on a stronger computer over SSH.
- **Guard rails.** Host access checks refuse configurations that reach into your computer, such as bind mounts, privileged mode and the Docker socket.
- **Docker Hosts.** One view for the VM of Devspaces and your remote hosts, with all their containers, images, volumes and networks. A click on an object opens its report in the editor, for example the VS Code Server versions and extensions that a volume holds. **Show Utilization** shows how busy a host and each of its containers are ([The view Docker Hosts](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/guide.md#the-view-docker-hosts)).

## Requirements

- VS Code 1.125 or later (the Microsoft build).
- For the VM of Devspaces: WSL 2.4.4 or later on Windows, QEMU and KVM on Linux. Or Docker Engine on a computer that you reach over SSH; then your computer needs no Docker. Podman is not supported.
- A GitHub account on github.com. Devspaces does not work with GitHub Enterprise Server or GHE.com.
- The Dev Containers extension. VS Code installs it with Devspaces.

## Usage

1. Select the **Devspaces** icon in the activity bar.
2. Select **Sign in with GitHub**. Your repositories with a Dev Container configuration appear, grouped by owner.
3. Double-click a repository, or select **Start** on its row. The first start takes a few minutes; later starts take seconds.
4. To go to another devspace, select the Devspaces item in the status bar, or run **Devspaces: Switch Devspace…** (`Cmd+Alt+E` on macOS).

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `devspaces.defaultImage` | `""` | An image that every repository can start from, also one without a Dev Container configuration. |
| `devspaces.stopOnClose` | `true` | Stop a devspace 5 minutes after its last window closes. |
| `devspaces.updateContainer` | `notify` | What a start does when a newer image is available: `yes` (update without a dialog), `notify` (Continue or Cancel) or `ask` (Update Now or Later). |
| `devspaces.cacheUpdateSchedule` | `7 6 * * *` | When the background updates run: a cron expression in your time zone, or minutes. |
| `devspaces.owners` | `[]` | The organizations and accounts whose repositories the view lists. Empty: all. |

All commands, settings and details are in the [user guide](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/guide.md).

## Uninstall

Before you uninstall Devspaces, run **Devspaces: Remove Devspaces from This Docker Engine…** on each Docker engine that you used. It removes the container `devspaces-monitor`, the helper containers and images, and the volumes `devspaces-monitor`, `devspaces-worker-cache` and `devspaces-vscode`, and it asks again before it deletes your devspaces. The [user guide](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/guide.md#uninstall) says how to remove the VM of Devspaces and its scheduled task.

---

[Change log](https://github.com/nimblescape/devspaces-vscode/blob/main/CHANGELOG.md) · [Contributing](https://github.com/nimblescape/devspaces-vscode/blob/main/CONTRIBUTING.md) · [User guide](https://github.com/nimblescape/devspaces-vscode/blob/main/docs/guide.md) · [Support](https://github.com/nimblescape/devspaces-vscode/blob/main/SUPPORT.md) · [Issues](https://github.com/nimblescape/devspaces-vscode/issues) · [Source](https://github.com/nimblescape/devspaces-vscode)

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](https://github.com/nimblescape/devspaces-vscode/blob/main/LICENSE).

The icons of Devspaces are based on the [Codicons](https://github.com/microsoft/vscode-codicons) of Microsoft, under the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) license. See [ThirdPartyNotices.txt](https://github.com/nimblescape/devspaces-vscode/blob/main/ThirdPartyNotices.txt).
