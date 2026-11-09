# Manual tests

The runners of GitHub have no WSL 2 on Windows and no nested virtualization on macOS, so CI cannot test the VM of Devspaces there. Each step that changes the VM on Windows or macOS has a list of manual tests here ([`R-VM-009`](requirements.md#r-vm-009)). Run them with a build of the branch (`npm run install-local`), and write the results into the pull request.

## The WSL distribution from the image of the VM

[`R-ENG-005`](requirements.md#r-eng-005), [`R-VM-002`](requirements.md#r-vm-002), [`R-VM-007`](requirements.md#r-vm-007), `src/core/docker/wslSetup.ts` and `src/vscode/wslSetupCommands.ts`. Before the tests: Windows 10 or 11 (Home too), on x64 and, when one is at hand, on Arm, a Windows user without administrator rights, WSL of the Microsoft Store, and no distribution `devspaces` (`wsl --list`).

1. **Setup without a question.** **Set Up Docker for Devspaces** in the view: no question of Devspaces and no prompt of Windows. The progress shows "Downloading the VM of Devspaces" with the megabytes, then "Creating the WSL distribution.", then "Starting the WSL distribution and Docker." The log names the version of the image, `ghcr.io/nimblescape/devspaces-vm`, the size of the file, and `Docker Engine` with its version at the end. Write down how long the first start took.
2. **The system of the image.** `wsl -d devspaces -u root -- cat /etc/os-release` names Debian 13, `wsl -d devspaces -u root -- systemctl is-active docker devspaces-upgrade.timer` says `active` twice, and `wsl -d devspaces -u root -- ls /mnt/c` fails, because no drive of Windows is mounted. The Start menu has no entry `devspaces`, and Windows Terminal has no profile for it.
3. **Not the default.** `wsl --list` does not mark `devspaces` as the default, also on a computer with no other distribution (then WSL has no default).
4. **A devspace.** Start a devspace and open it: it works as with Docker Desktop.
5. **The upgrade in the VM.** Keep the distribution running for 2 minutes after its first start: `wsl -d devspaces -u root -- journalctl -u devspaces-upgrade --no-pager` shows a run of the service. It says `skipped` when the image is less than 20 hours old (the version of the image in the log is its build time in UTC), and otherwise it upgrades the packages. The devspace of test 4 still runs afterwards.
6. **The command again.** Run **Devspaces: Set Up Docker for Devspaces in WSL…** again: no question, no download, and the log says that the distribution exists and Devspaces uses it.
7. **Without a connection.** Remove the distribution (**Devspaces: Remove the WSL Distribution of Devspaces…**), turn off the network, and set it up again: the message says that the image of the VM could not be downloaded, and **Show details** names `ghcr.io`. Turn on the network, and set it up again.

## The idle script in WSL

[`R-VM-004`](requirements.md#r-vm-004), `src/core/docker/wslKeeper.ts` and `src/core/docker/wslLifetime.ts`. Before the tests: the WSL distribution of Devspaces set up with this build, and no devspace running there. `wsl --list --running` shows whether the distribution runs without starting it; each `wsl -d devspaces …` below starts it when it does not run, and WSL stops it again 15 seconds after that command ended when nothing else holds it.

1. **One keeper, no window.** Start a devspace in the distribution and open it, and open a second VS Code window with the view of Devspaces. No console window appears. `wsl -d devspaces -u root --exec pgrep -c -x idle` says `1`. The log of Devspaces has "Devspaces starts the keeper of the WSL distribution devspaces (wslg.exe)".
2. **Runs after VS Code closed.** Choose **Keep Running When Closed** for the devspace of test 1, and close VS Code. 10 minutes later, `wsl --list --running` still names `devspaces`.
3. **Stops when nothing runs, also with a window open.** Open VS Code, choose **Stop When Closed** and **Stop** for the devspace, and leave the window open without using Devspaces. The Monitor ends 5 minutes after the stop, and the workers of Devspaces close 10 minutes after their last use; about 2 minutes after the last container stopped, `wsl --list --running` no longer names `devspaces`. Then `wsl -d devspaces -u root -- cat /var/log/devspaces-idle.log` shows "The keeper runs the idle script.", "Busy: a container runs.", "Nothing runs in the VM of Devspaces (1 of 2 checks).", "(2 of 2 checks)" and "The VM of Devspaces stops.".
4. **The background leaves it stopped.** After test 3, click into the view of Devspaces: the view shows the devspace as stopped, with **Start**, `wsl --list --running` still does not name `devspaces`, and the log of Devspaces says that the distribution does not run and that Devspaces does not start it for its work in the background.
5. **A start starts it.** Start the devspace again: the distribution runs, and `pgrep -c -x idle` of test 1 says `1` again.

## The scheduled task on Windows

[`R-VM-005`](requirements.md#r-vm-005), `src/core/docker/wslTask.ts`. Before the tests: Windows 10 or 11 (Home too), a Windows user without administrator rights, WSL of the Microsoft Store, the WSL distribution of Devspaces set up with this build, and one devspace started there once, so that the Monitor exists. `whoami /user` shows the SID of your user; below, `<task>` is `nimblescape Devspaces WSL <SID>`.

1. **Created after the setup, without a prompt.** No prompt of Windows appeared at the setup. The log of Devspaces has "Devspaces wrote its scheduled task". `schtasks /Query /TN "<task>" /V /FO LIST` shows the task: "Run As User" is your user, "Logon Mode" is "Interactive only", "Scheduled Type" is daily at 06:12 (the default schedule 06:07 plus 5 minutes). `%LOCALAPPDATA%\nimblescape\devspaces\task\task.xml` exists.
2. **The triggers follow the setting.** Set `devspaces.cacheUpdateSchedule` to `30 */3 * * 1-5`: Task Scheduler (`taskschd.msc`, root folder **Task Scheduler Library**) shows 8 weekly triggers, Monday to Friday, at 00:35, 03:35, … 21:35. Set it to `90`: one daily trigger at 00:05 that repeats every 1 hour 30 minutes for 1 day. Set it back to the default: one daily trigger at 06:12. Each change writes one line in the log.
3. **A new window changes nothing.** Reload the window: no new line "Devspaces wrote its scheduled task", and the time of `task.xml` stays.
4. **A run while VS Code is closed.** Set the schedule to a time 2 minutes from now (for example `40 14 * * *` at 14:38), close VS Code, and stop the distribution (`wsl --terminate devspaces`). 5 minutes after that time, no console window appears, and `wsl --list --verbose` shows `devspaces` as running. It stops by itself about 2 minutes after the Monitor ended (5 minutes after its background run). Then `wsl -d devspaces -u root -- cat /var/log/devspaces-task.log` shows "The task starts the Monitor" and "The Monitor runs", and `wsl -d devspaces -u root -- docker logs devspaces-monitor` shows the background run. Task Scheduler shows "The operation completed successfully. (0x0)" as the last run result.
5. **A missed time.** Put the computer to sleep before a time of the schedule and wake it after that time: the task starts about 10 minutes after the wake (the history of the task in Task Scheduler, and the log of the task).
6. **On battery.** On a laptop on battery, test 4 runs as well.
7. **After the registration.** Write down whether Task Scheduler starts the task once about 10 minutes after test 1 or test 2 (a start boundary in the past with "Run task as soon as possible after a scheduled start is missed"). That is harmless: the Monitor runs its background run only when it is due.
8. **Removal.** **Devspaces: Remove the WSL Distribution of Devspaces…**: `schtasks /Query /TN "<task>"` says that the task does not exist, `task.xml` is gone, and the log has "Devspaces removed its scheduled task".
9. **A distribution of your own.** With a distribution `devspaces` that you made yourself (not with the setup of Devspaces), no task is created.

## The scheduled task on macOS

[`R-VM-005`](requirements.md#r-vm-005), `src/core/vm/vmTask.ts` and `src/vmTask/main.ts`. Before the tests: a Mac with the VM of Devspaces set up with this build, and one devspace started there once.

1. **Created after the setup.** `launchctl print gui/$(id -u)/com.nimblescape.devspaces.vm` shows the agent, and `~/.nimblescape/devspaces/task` has `vmTask.js`, `task.json` and `last-start.json`.
2. **A run while VS Code is closed.** Set the schedule to a time 2 minutes from now, quit VS Code, and wait until the VM powered itself off (`LIMA_HOME="$HOME/.nimblescape/devspaces/vm" "$HOME"/.nimblescape/devspaces/lima/*/bin/limactl list`). 5 minutes after that time, the VM runs, and `~/.nimblescape/devspaces/task/task.log` says that the Monitor runs with the schedule. Later the VM powers itself off again.
3. **A missed time.** Put the Mac to sleep before a time of the schedule and wake it after that time: the VM starts 5 minutes after the wake. Log out before a time of the schedule and log in after it: the VM starts 5 minutes after the login.
4. **No start without a missed time.** Log out and in when no time of the schedule passed since the last start: `task.log` gets no new line, and the VM stays off.
5. **Removal.** Delete the VM with the commands of [Uninstall](guide.md#uninstall) and open a window of VS Code: the agent and `~/Library/LaunchAgents/com.nimblescape.devspaces.vm.plist` are gone.
