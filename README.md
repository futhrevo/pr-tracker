# pr-tracker

Tracks your GitHub pull requests from inside Claude Code, using the `gh` CLI.

- **My PRs pane** (opens at session start, or with `/prs`): your open PRs in the current repo with
  merge state, review decision, CI counts and comment count. Press a row to see each CI run (linked
  to its logs) and the latest comments and reviews. Merged PRs show 5 at a time; page with ▲/▼ or `k`/`j`.
- **Row above the prompt:** every PR this session creates with `gh pr create`, with live status.
  Click `#N` to open it in the browser.

Refreshes every 2 minutes; `r` in the pane refreshes now.

Needs `gh` installed and signed in (`gh auth login`). Opening a PR from the row uses macOS `open`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pr-tracker --marketplace futhrevo/pr-tracker
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install pr-tracker --marketplace futhrevo/pr-tracker
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `futhrevo/pr-tracker`, then Add plugin.
