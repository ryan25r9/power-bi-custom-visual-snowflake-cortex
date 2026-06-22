## What & why
<!-- One or two lines. Link any issue. -->

## Area (which CI gates apply)
- [ ] **Phase 2** — `visual/ proxy/ snowflake/ tests/ tools/`
- [ ] **Phase 1** — `phase1/**`

## Gates run locally before pushing
Phase 2 (run all three — see CLAUDE.md):
- [ ] `bash tests/run-tests.sh`
- [ ] `bash tools/run-e2e.sh`
- [ ] `(cd visual && ./node_modules/.bin/pbiviz package)`

Phase 1:
- [ ] `bash phase1/visual/tests/run-tests.sh`
- [ ] `(cd phase1/visual && ./node_modules/.bin/pbiviz package)`

## Checklist
- [ ] Branched off `main`; branch name follows the convention (`phase1/* phase2/* fix/* claude/* briefs/*`)
- [ ] No secrets committed (keys stay in localStorage / the proxy / the dataset connection — never in the pbix or format pane)
- [ ] CI is green and a review is requested
