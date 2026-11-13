# Contact Names Implementation Plan

> **For agentic workers:** Use the existing session to implement and verify these tasks; request a separate review of identity preservation before landing.

**Goal:** Keep imported contact names recognizable while retaining their full source and user edits.
**Architecture:** A shared deterministic naming module runs during discovery. Existing `name` remains the visible identity; `sourceName` and `nameSource` retain provenance without changing bindings.
**Tech Stack:** Existing Node ESM, TypeScript, React and Playwright.
**Spec:** `docs/superpowers/specs/2026-11-14-contact-names-design.md`.

## Global Constraints

No new dependencies, inferred roles, same-name merging, historical snapshot rewrites or real-account test writes. Keep custom names at the existing 80-character limit and automatic labels within 28 display units.

## Review Focus

- Legacy edited and ambiguous contacts retain their names.
- Provider changes do not overwrite a chosen name.
- Emoji and non-Latin labels remain intact.
- Short names retain search access to the complete source.
- Background discovery invalidates stale editors if it changes a name.

### Task 1: Naming and provenance

- [x] Add focused failing tests for automatic labels, legacy identities, custom names, versions and restart continuity.
- [x] Add `suggestContactName(sourceName, fallbackName, suffix)` and `discoveredContactName(previous, sourceName, fallbackName, suffix)` in `apps/personal/server/contact-names.mjs` with a declaration file.
- [x] Apply them in Messenger discovery and pin explicitly saved names as custom. Add the module to package copying and runtime fingerprints.
- [x] Run naming and Messenger regression tests.

### Task 2: Full-name access and delivery

- [x] Expose source names in contact details and the editor, provide an explicit suggested-name action, and search both names.
- [x] Update the API and UI contracts.
- [x] Verify long titles, custom names, reload continuity and narrow layouts through an isolated browser workspace.
- [x] Run applicable typechecks and regressions and obtain independent review.
- [ ] Open the linked PR and land after applicable gates pass.
