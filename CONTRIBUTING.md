# Contributing

This repo holds three phases of the same product (see the [README](README.md#repository-phases)).
Two people work in it at once, so a few simple rules keep `main` healthy.

**`main` is PR-only by convention.** Don't commit straight to `main`. Every change
goes through a branch and a pull request. CI runs the build gates on each PR — wait
for it to go green, get a quick review, then merge. (The repo is private on the free
GitHub plan, so this is convention, not a server-enforced rule. If it ever moves to
GitHub Pro it can be enforced — see the bottom of this file.)

## Who owns what

| Area | Folder | Owner |
|---|---|---|
| Phase 2 (proxy + streaming chat) | `visual/ proxy/ snowflake/ tests/ tools/` and root config | maintainer |
| Phase 1 (M-query demo) | `phase1/` | second developer |

`CODEOWNERS` requests the right reviewer automatically based on which files you touch.

## Branch names

| Prefix | For |
|---|---|
| `phase1/*` | Phase 1 work |
| `phase2/*` | Phase 2 feature work |
| `fix/*` | bug fixes in either area |
| `claude/*`, `briefs/*` | the maintainer's automated runs |

## Track A — standard IDE (plain git, no extra tooling)

This is the everyday path. You do **not** run any of the helper scripts or git hooks.

```bash
git clone https://github.com/ryan25r9/power-bi-custom-visual-snowflake-cortex.git
cd power-bi-custom-visual-snowflake-cortex
git checkout -b phase1/my-feature
# ...edit files (you'll mostly be in phase1/)...
git add -A && git commit -m "phase1: short description"
git push -u origin phase1/my-feature
# open a pull request on GitHub (or: gh pr create)
```

Then: wait for **CI to go green** on the PR, get **one review**, and click **Squash and
merge**. If CI is red, push more commits to the same branch — it re-runs automatically.

To run the Phase 1 gates locally before pushing:

```bash
cd phase1/visual && npm install
bash tests/run-tests.sh          # contextBuilder unit tests
./node_modules/.bin/pbiviz package   # builds the .pbiviz
```

## Track B — maintainer / Claude helpers (optional, machine-local)

The repo ships helper scripts that automate the same branch → PR flow. They only
activate for whoever opts in, and never affect Track A:

```bash
./setup-hooks.sh        # once per clone: post-commit auto-pushes the CURRENT branch (never main)
./sync.sh "message"     # commit -> feature branch -> PR -> squash merge -> fast-forward local main
```

`claude/*` and `briefs/*` PRs are auto-merged by the `Auto-merge Claude PRs` workflow.
That convenience is scoped to the maintainer's own automation; everything else goes
through the reviewed flow above.

## CI gates on your PR

- **Phase 2 changes** (`visual/ proxy/ snowflake/ tests/ tools/`) run all three gates:
  `tests/run-tests.sh`, `tools/run-e2e.sh`, and `pbiviz package` (see [CLAUDE.md](CLAUDE.md)).
- **Phase 1 changes** (`phase1/**`) run the contextBuilder unit test and `pbiviz package`.

A PR that doesn't touch an area skips that area's gate automatically.

## If you want enforcement later (GitHub Pro)

On a private repo, required checks and required reviews need GitHub Pro (~$4/mo) or a
public repo. If you upgrade, in **Settings → Branches** protect `main`: require a PR,
require the `phase2-gates` and `phase1-gates` checks, and require 1 review. Then the
"wait for green + review" convention above becomes enforced rather than honor-system.
