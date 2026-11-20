# Set up the PR triage dashboard and tours

Follow these steps from a Swamp repository. Replace `octo-org/octo-repo`,
`octocat`, and the checkout path with the reader’s values. Ask before starting
an agent run or setting up a recurring refresh; neither is needed to see the
dashboard.

## 1. Check prerequisites and install

```sh
swamp --version
gh auth status
git --version
swamp extension pull @mgreten/pr-triage
swamp extension pull @mgreten/pr-tour
swamp extension pull @mgreten/cli-agent
```

If starting from scratch,
`mkdir pr-dashboard && cd pr-dashboard && git init -q && swamp repo init` before
pulling. Use the same working directory and datastore for the scan, tour
workflow, and servers.

## 2. Create the scan and server instances

Use separate instances so the foreground server cannot lock out a scan. Share
their output directory and keep it dedicated to this repository. Use the names
shown so the shipped workflows can find their instances.

```sh
swamp behavior create @mgreten/pr-triage pr-triage \
  --global-arg repo=octo-org/octo-repo --global-arg login=octocat
swamp behavior create @mgreten/pr-triage pr-triage-server \
  --global-arg repo=octo-org/octo-repo --global-arg login=octocat \
  --global-arg webhookSecretFile="$HOME/.pr-triage/webhook-secret"
swamp workflow validate @mgreten/pr-triage
swamp workflow run @mgreten/pr-triage
```

Check that `~/.pr-triage/board.json` exists and names the intended repository.
The scan only reads open PRs. To change settings such as `peers` (an array of
GitHub logins), `reviewPool` or theme, get the instance path with
`swamp behavior get pr-triage --json`, edit its `globalArguments`, and validate
the instance. Repeat for the server where appropriate.

## 3. Wire the tour click

The selected agent CLI must be installed and logged in. You need a checkout of
the target repo with a GitHub remote (normally `origin`). Do not create a
duplicate `cli-agent` if you already have one. `@mgreten/pr-tour` creates a
temporary worktree for the one PR the reader selects.

```sh
swamp behavior create @mgreten/cli-agent cli-agent
swamp behavior create @mgreten/pr-tour pr-tour \
  --global-arg repoSlug=octo-org/octo-repo \
  --global-arg repoPath="$HOME/code/octo-repo" \
  --global-arg agentProvider=claude \
  --global-arg pageBaseUrl=http://127.0.0.1:8765/tours
swamp workflow validate @mgreten/pr-tour
mkdir -p "$HOME/.pr-triage"
(umask 077; test -e "$HOME/.pr-triage/webhook-secret" || \
  openssl rand -hex 32 > "$HOME/.pr-triage/webhook-secret")
```

In a terminal, start Swamp’s loopback webhook listener:

```sh
swamp serve --host 127.0.0.1 --port 8899 \
  --webhook "/pr-tour:@mgreten/pr-tour:@file=$HOME/.pr-triage/webhook-secret:generic:X-PrTriage-Signature:sha256="
```

For an existing `swamp serve` use a matching route and set `webhookPort` on
`pr-triage-server` to that listener’s loopback port. The webhook secret belongs
on disk, never in a page or browser storage.

## 4. Open the dashboard

In another terminal in the same Swamp repository:

```sh
swamp behavior run pr-triage-server serve
```

Open `http://127.0.0.1:8765/` (use `127.0.0.1`, not `localhost`). Check that the
lanes render and `/board` reports `ok: true`. With the reader’s approval, click
**Tour** on one small PR; watch the webhook workflow log, then check for **Open
tour**. The board polls every 30 seconds and detects when the matching page is
ready. Stop the terminal commands with Ctrl-C.

For a read-only dashboard, omit `webhookSecretFile` in step 2 and skip step 3.
Refresh PR data manually with `swamp workflow run @mgreten/pr-triage`, or use
your own scheduler for that workflow alone. The page polling interval is not a
GitHub polling schedule. Do not add reviews or tour builds to a scheduled
refresh.

If `/board` has no PRs, check the scan and its report before troubleshooting the
server. If an action returns 404, check the secret file setting and webhook
route. If a tour fails, read the workflow summary and check that the tour
`pagesDir` equals the dashboard `toursDir`. Keep both listeners local; the
dashboard does not authenticate remote viewers.
