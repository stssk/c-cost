# c-cost

A small Claude Code plugin that shows what your session is costing, live, in a right-aligned line just above the prompt.

- **On a Pro/Max subscription** it draws a progress bar for each rate-limit window (5-hour and 7-day), with the percent used and the time until it resets. The bars go green → yellow (70%) → red (90%). The API-price equivalent is shown dimly beside them as `≈$…`.
- **On an API key** it shows the session's spend in USD, as `/cost` totals it, and a bar for the month against your spend limit.

```
            5h ██░░░░░░░░ 23% ↻2h14   7d ████░░░░░░ 41% ↻3d   ≈$1.240
> _
```
```
                     session $0.432   month ███░░░░░░░ 34% ≈$170.00 / $500.00 ↻8d
> _
```

It switches between the two by itself.

### The month bar

Where the API reports a spend limit (the one `/usage` shows), the bar is that reading: the percent of the limit used and when it resets. The API reports a percent, not dollars, so to see the amounts as well, set your limit:

```
/config   →   c-cost: Monthly spend limit (USD)
```

or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "c-cost": { "options": { "monthlyLimitUsd": 500 } } } }
```

Where the API reports no spend limit, the plugin counts the month itself: the sum of every session's cost on this machine in the calendar month, drawn against `monthlyLimitUsd` (just the total, with no bar, while it is unset). That count only knows this machine's Claude Code sessions, not other tools or colleagues on the same key. The line updates after every turn and whenever a window moves by a whole percent; it appears after your first message in a session, once the API has reported the figures.

## Install

### From GitHub

At the prompt of a Claude Code terminal session:

```
/plugin install c-cost --marketplace stssk/c-cost
```

Or from a shell:

```sh
claude plugin install c-cost --marketplace stssk/c-cost
```

Answer `y` to add the marketplace, then pick a scope (user scope, the first one, makes it load in every session). It is active right away.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `stssk/c-cost`, then **Add plugin**.

If the repository is private, the install only works on machines that already have a git credential for github.com (an SSH key, or `gh auth login` followed by `gh auth setup-git`).

### From a local clone

```sh
git clone <this repo> ~/Developer/stssk/c-cost
claude plugin install c-cost --marketplace ~/Developer/stssk/c-cost
```

### Without installing

To try it for one session, straight from the folder:

```sh
claude --plugin-dir ~/Developer/stssk/c-cost
```

## Uninstall

```
/plugin uninstall c-cost
```

## Development

The plugin is one hooks module, `hooks/register.tsx`. It listens to `session.measure` for the figures, keeps them in session state, and draws them through a `ui.render` hook on the `AbovePrompt` band.

```sh
claude plugin validate .
claude --plugin-dir .      # loads it; edits reload when a turn ends
```

Claude Code writes the API's type declarations to `.claude-plugin/types/` (git-ignored) when it loads the plugin; after that `tsc -p .` type-checks it.
