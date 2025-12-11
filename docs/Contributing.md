# Contributing Guide

Thank you for contributing to zion-next. This guide describes our lightweight workflow to keep changes traceable and collaboration smooth.

## Workflow

- Create small PRs. Use Conventional Commits:
  - feat(scope): new feature
  - fix(scope): bug fix
  - refactor(scope): code changes without feature/bug
  - docs(scope): docs only
  - chore(scope): tooling, config
  - test(scope): tests only
- Each PR must:
  - Update docs/Changelog.md (section “Unreleased”) with Added/Changed/Fixed.
  - Update docs/Extensions-API.md and/or docs/Development.md if you changed an API or workflow.
  - Update docs/Roadmap.md if the direction/timeline is impacted.
  - Add an ADR (docs/decisions/ADR-YYYY-MM-DD-title.md) for structural/architectural decisions (1–2 pages max).

## Running locally

- Install: `npm i`
- Dev server: `npm run dev`
- Tests: `npm run test` (vitest)

## Project structure (short)

- src/core: EventBus, StateBus (core buses)
- src/editor: EditorCore (CM6 adapter), EditorProxy
- src/ext: registry (extension registry + window.zion API)
- src/types: zion.d.ts (public contracts)
- extensions: sample extensions
- docs: docs and ADRs
- tests: vitest tests

## Docs-first checklist

For every change, confirm:
- [ ] Changelog entry under “Unreleased”
- [ ] API doc updated (if any): docs/Extensions-API.md or docs/Development.md
- [ ] Roadmap updated (if relevant)
- [ ] ADR created (if a structural/architectural decision)

## Coding standards

- Keep EditorProxy minimal; do not expose raw CodeMirror internals.
- Favor extension points (commands, menus, keybindings, messages, pasteHandlers, decorators) for new features.
- Use Disposables to clean up listeners and DOM.
- Tests: prefer unit tests for core (buses/registry) and minimal DOM tests for editor features.

## Release hygiene

- We keep docs/Changelog.md as the single source of truth.
- Weekly: move “Unreleased” entries into a tagged version section when we cut a release.

Thanks for helping build a great LLM interaction editor!