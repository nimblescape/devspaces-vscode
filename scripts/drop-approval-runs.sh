#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# Deletes the workflow runs of the pull request of the branch $1 that wait for an approval. The jobs "pull request" of
# the pin workflows (docker-cli.yml, buildx-image.yml, vm-image.yml, lima.yml, node-version.yml) open their pull request
# with the GITHUB_TOKEN, and GitHub creates the runs of the event pull_request of such a pull request only in the state
# "approval required" (conclusion action_required): they run no job until a person approves them. The job starts the
# workflow "CI" (lima.yml also "VM image") on the branch itself instead, and the checks of that run appear on the pull
# request. A waiting run that nobody approves ends as a failed run when the pull request is merged or closed, so every
# pin left one failed run of each workflow that its change starts in the list of runs (for example the run 42367557515
# of "CI" for the pull request #81). A deleted run is gone from that list.
#
#   bash scripts/drop-approval-runs.sh lima-2.3.0
#
# GitHub creates these runs a few seconds after the pull request. The script looks for them every 5 seconds, for at most
# 2 minutes, and stops 15 seconds after it deleted the last one it found. It never fails: a run that it cannot list or
# delete gives a warning, because the pull request and its checks are there already. It needs GH_TOKEN with the
# permission actions: write and GITHUB_REPOSITORY, as GitHub Actions sets them, and the GitHub CLI.
set -u

branch="${1:?the branch of the pull request}"
poll_seconds=5
max_polls=24
quiet_polls=3

deleted=0
quiet=0
failed=' '
for ((poll = 1; poll <= max_polls; poll++)); do
  sleep "$poll_seconds"
  if ! ids="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?branch=$branch&event=pull_request&status=action_required&per_page=100" --jq '.workflow_runs[].id')"; then
    echo "::warning::The runs of the branch $branch could not be listed."
    continue
  fi
  found=0
  for id in $ids; do
    [[ "$failed" == *" $id "* ]] && continue
    found=1
    if gh api --method DELETE "repos/$GITHUB_REPOSITORY/actions/runs/$id" > /dev/null; then
      echo "Deleted the run $id of the pull request of $branch, which waited for an approval."
      deleted=$((deleted + 1))
    else
      echo "::warning::The run $id of the pull request of $branch, which waits for an approval, could not be deleted."
      failed="$failed$id "
    fi
  done
  if ((found == 1)); then
    quiet=0
  elif ((deleted > 0)); then
    quiet=$((quiet + 1))
    ((quiet >= quiet_polls)) && break
  fi
done
echo "Deleted $deleted runs of the pull request of $branch that waited for an approval." | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
