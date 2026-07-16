# Contributing

**`main` is PR-only by convention.** Don't commit straight to `main`. Every change
goes through a branch and a pull request. CI runs the build gates on each PR — wait
for it to go green, get a quick review, then merge. (The repo is private on the free
GitHub plan, so this is convention, not a server-enforced rule. If it ever moves to
GitHub Pro it can be enforced — see the bottom of this file.)

## Branch names

| Prefix | For |
|---|---|
| `feat/*` | feature work |
| `fix/*` | bug fixes |
| `docs/*`, `refactor/*`, `chore/*` | what they say |
| `claude/*`, `briefs/*` | the maintainer's automated runs |

## Track A — standard IDE (plain git, no extra tooling)

This is the everyday path. You do **not** run any of the helper scripts or git hooks.

```bash
git clone https://github.com/ryan25r9/power-bi-custom-visual-snowflake-cortex.git
cd power-bi-custom-visual-snowflake-cortex
git checkout -b feat/my-feature
# ...edit files...
git add <the files you changed> && git commit -m "short description"
git push -u origin feat/my-feature
# open a pull request on GitHub (or: gh pr create)
```

Then: wait for **CI to go green** on the PR, get **one review**, and click **Squash and
merge**. If CI is red, push more commits to the same branch — it re-runs automatically.

To run the gates locally before pushing (see [CLAUDE.md](CLAUDE.md) for the one-time
`npm install` steps):

```bash
bash tests/run-tests.sh                            # unit tests
bash tools/run-e2e.sh                              # mock-Snowflake → proxy streaming E2E
(cd visual && ./node_modules/.bin/pbiviz package)  # builds the .pbiviz
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

Changes under `visual/ proxy/ snowflake/ tests/ tools/` (or the CI workflow itself)
run all three gates above. Docs-only PRs skip them automatically.

## If you want enforcement later (GitHub Pro)

On a private repo, required checks and required reviews need GitHub Pro (~$4/mo) or a
public repo. If you upgrade, in **Settings → Branches** protect `main`: require a PR,
require the `gates` check, and require 1 review. Then the "wait for green + review"
convention above becomes enforced rather than honor-system.
