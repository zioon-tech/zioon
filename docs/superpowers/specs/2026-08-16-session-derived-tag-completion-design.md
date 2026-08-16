# Session Derived Tag Completion Design

## Goal

Include Biography-generated session tags in the `#tag` completion popup without
rescanning session documents, reading persistent storage, or coupling the editor
to the Biography plugin.

## Data Source

The completion source reads the existing provider-neutral
`sessions.derivedTags` StateBus value. It does not invoke Biography, inspect
session documents, or update the manual tag catalog.

All tag paths from all providers and sessions are normalized to `#path` labels
and deduplicated globally. Invalid or empty state is treated as no derived tags,
so existing completion remains available if the state is absent.

## Caching

The completion module keeps the last `sessions.derivedTags` object reference and
its aggregated tag options. A completion request reads the current state once:

- If the object reference is unchanged, it returns the cached aggregation.
- If the object reference changed, it rebuilds and replaces the cache once.

Derived-tag publishers already replace the top-level registry object through
StateBus, so reference identity is a sufficient invalidation signal. Typing
additional characters does not repeatedly traverse the registry.

## Completion Behavior

Candidate precedence remains:

1. Tags in the current editor document.
2. Tags extracted from existing session documents.
3. Derived tags from `sessions.derivedTags`.

The existing `seen` set deduplicates labels across these sources. A derived tag
already present in the current document or session documents keeps the earlier
candidate and is not shown twice.

Derived candidates use their source label in the detail text, for example
`Biography 自动标签`. Prefix filtering and the existing 50-option limit apply
unchanged.

## Scope

This change affects only editor tag completion. It does not:

- Persist derived tags into the manual catalog.
- Change tag-tree filtering or source badges.
- Make Biography tags editable.
- Alter tag extraction or exclusion rules.

## Verification

Focused tests will cover:

- Aggregation across multiple sessions.
- Deduplication within and across providers.
- Cache reuse while the state reference is unchanged.
- Cache invalidation after StateBus publishes a new registry object.
- Prefix filtering and precedence over duplicate derived candidates.
- Graceful behavior for missing or malformed state.
