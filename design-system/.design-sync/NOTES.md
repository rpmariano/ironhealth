# NOTES

## Re-sync risks (fast-path first sync — read before trusting future carry-forward)

- **Automated fidelity grading was skipped.** This sync did not install
  Playwright/Chromium and did not run `compare.mjs`'s screenshot-diff grading
  loop (`[NO_CHROMIUM]` on the `resync.mjs` capture stage — expected, by
  choice). All 8 components (`Badge`, `Button`, `Card`, `Chip`, `ColorSwatch`,
  `NavIconButton`, `ProgressBar`, `TabButton`) are in `verification.pendingGrade`
  with no `.grade.json` on disk. Fidelity was instead verified manually in the
  same session: each component's Storybook story was opened in a real browser
  and screenshotted, and visually compared against the equivalent markup in
  the source app (`../index.html`) — same classes, same rendered look. That is
  a real but informal check, not the automated grading contract this skill
  normally requires before upload.
- **If a future sync installs Playwright and runs the full compare loop**,
  treat the first grading pass as the real baseline, not a formality — nothing
  here has machine-graded verdicts yet.
- **`package.json` needed explicit `main`/`module`/`types`/`exports` fields**
  for the converter's export-detection to find anything (`exportedNames()`
  reads them, not the `--entry` CLI flag) — without them the build silently
  produced 0 components (`[TITLE_UNMAPPED]` on all 8, "exported PascalCase
  symbols: 0"). If this field set is ever removed as "unnecessary" for a pure
  Vite-lib build, the sync will regress the same way.
- **`docs: 0/8 components matched`** during build — the converter's docs
  discovery (`cfg.docsMap`) found no separate documentation source for any
  component (there isn't one — each component's only doc is its own
  `.stories.tsx` + inline JSDoc on props). Not an error, just means README/
  per-component docs lean entirely on the `.prompt.md` generated from stories
  and prop comments.
- **Group naming is `components/components/<Name>/`** (doubled) because every
  story title is `"Components/<Name>"` and the converter derives the group
  from that prefix. Cosmetic only — fix by dropping the `Components/` prefix
  from each `.stories.tsx` `title` field and rebuilding, if it's ever worth a
  rebuild on its own.
