## What & why
<!-- One or two lines. Link any issue. -->

## Gates run locally before pushing (all three — see CLAUDE.md)
- [ ] `bash tests/run-tests.sh`
- [ ] `bash tools/run-e2e.sh`
- [ ] `(cd visual && ./node_modules/.bin/pbiviz package)`

## Checklist
- [ ] Branched off `main`; branch name follows the convention (`feat/* fix/* docs/* refactor/* chore/* claude/* briefs/*`)
- [ ] No secrets committed (keys stay in localStorage / the proxy — never in the pbix or format pane)
- [ ] SETUP.md / ARCHITECTURE.md updated if config or design changed
- [ ] CI is green and a review is requested
