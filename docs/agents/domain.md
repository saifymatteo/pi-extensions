# Domain Docs

## Before exploring

This repo uses a single-context layout across its extension packages:

- Read `GLOSSARY.md` at the repo root for shared terminology.
- Read ADRs in root `docs/adr/` that touch the area you are about to work in.

If these files do not exist, proceed silently. Create them lazily through `/domain-modeling` when terms or decisions are resolved, rather than scaffolding empty documents.

## Use the glossary's vocabulary

When naming a domain concept in an issue, proposal, hypothesis, or test, use the glossary's defined term rather than synonyms it excludes.

If a needed concept is missing, check whether the codebase already has a name for it. Note a genuine vocabulary gap for `/domain-modeling`.

## Flag ADR conflicts

Surface any proposal that contradicts an existing ADR. Cite the ADR and explain why reopening the decision is warranted rather than silently overriding it.
