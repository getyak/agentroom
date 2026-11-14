# Contact picker implementation plan

**Goal:** Make choosing and reviewing chat members immediately understandable.

**Architecture:** Keep the current GroupEditor save contract; separate directory browsing from the selected-member summary. Scope layout to a dedicated stylesheet.

**Tech stack:** React 19, TypeScript, existing lucide icons and CSS tokens.

**Spec:** ../specs/2026-11-14-contact-picker-design.md

## Constraints and review focus

- Preserve unknown historical IDs, old pair groups, response policies and idempotent saves.
- Hidden filters must never remove selected members; checkbox changes must not reorder the directory.
- Search must reveal matching unavailable contacts and distinguish duplicate names.
- Name validation must remain reachable; Enter in search must not submit.
- Short and narrow windows must retain accessible search, summary and footer.

## Implementation

- [x] Refactor GroupEditor in `apps/personal/src/MessengerDialogs.tsx`: stable grouped directory, search and category filters, selection summary, compact group identity, advanced disclosure and fixed footer. Keep existing test IDs for saved controls.
- [x] Add `apps/personal/src/group-editor.css`, reusing semantic tokens, accessible native controls and responsive bounded layouts.
- [x] Add `dev/contact-picker-acceptance.mjs` using an isolated synthetic personal server: verify duplicates, filters, offline discovery, stable selection, unknown IDs, save failure, direct/group behavior, policy preservation and viewports. Update affected existing acceptance scripts to explicitly open the new disclosures.
- [x] Update `docs/design.md`, `docs/clients.md` and CI browser coverage.
- [ ] Run personal typecheck/build, focused browser/native acceptance and affected regressions. Independently review the final diff, address confirmed issues, link the PR to GET-549, merge after applicable CI passes, then validate the installed build before completing the issue.
