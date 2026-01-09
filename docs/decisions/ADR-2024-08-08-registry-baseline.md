# ADR: Extension Registry Baseline

Date: 2024-08-08
Status: Accepted
Decision-makers: Core maintainers

## Context

zion-next aims to keep the core small and stable while enabling feature growth via extensions. We need a stable, documented set of extension points and a simple runtime API available in the renderer (window.zion). Early features (commands, keybindings, menus, paste handlers, decorators, status bar, message contributors, basic models registry) already exist and should be treated as the baseline.

## Decision

- Adopt `src/ext/registry.ts` as the single extension registry that exposes `window.zion`.
- Public API surface is defined in `src/types/zion.d.ts`.
- Supported contribution points (baseline):
  - commands (register/execute)
  - keybindings (register/list)
  - menus (register/show for editor/context)
  - messages (registerContributor with pre/post stages)
  - events (EventBus)
  - state (StateBus)
  - statusBar (registerItem)
  - editor (registerPasteHandler, registerDecorator)
  - models (registerProvider, listProviders, getProvider)
- Editor access for extensions is always via EditorProxy (safe wrapper).

## Consequences

- New features should prefer extensions over core changes when feasible.
- Any public API changes must update:
  - docs/Extensions-API.md
  - docs/Changelog.md (Unreleased)
  - tests covering new behavior
- Core will keep adding hooks (e.g., more menus, more panels) through the registry instead of bespoke wiring.

## Alternatives considered

- Direct plugin access to Editor internals: rejected due to stability and security.
- Early introduction of a dedicated extension host process: postponed to a later phase; we stay in the renderer while APIs are maturing.

## Follow-ups

- Expand examples under extensions/dev.* to demonstrate each contribution point.
- Add more tests for paste priority and decorators lifecycle (added).
- Add an Extension Settings convention (per-extension namespace under localStorage) and document it.