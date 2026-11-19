# Upstream provenance

This directory contains a project-scoped installation of Google's `retrieving-developer-knowledge` Agent Skill.

- Upstream repository: https://github.com/google/skills
- Upstream commit pinned: `06fff9e3edb7fc3c115a1769406047fcaf0a6289`
- Upstream skill path: `skills/developers/retrieving-developer-knowledge/`
- Upstream license: Apache-2.0 (the full license is included as `LICENSE` in this directory).
- Retrieved on: 2026-11-19.
- Installation format: vendored into `.agents/skills/` so a coding agent that supports repository-scoped Agent Skills can discover it without cloning or loading all 217 upstream skills.

## Pinned upstream file hashes

| Upstream file | Git blob SHA |
|---|---|
| `SKILL.md` | `123a151f2ad4b4acc08e0814cbb12a1abeb50f55` |
| `references/attribution.md` | `75d5cc8c0a9e8472d5f4c90746441e532c928c81` |
| `references/mcp-usage.md` | `6965740d9e5acdeb9179f7a6c6b663fe0671c9f2` |
| `references/api-fallback.md` | `b460ab78d2cbdbb9590967831e65e6b9e08bc041` |
| `references/supported-domains.md` | `81778968b974bc5c4c4cb7eadfd38a4e3867c3b1` |
| `LICENSE` | `d645695673349e3947e8e5ae42332d0ac3164cd7` |

## Downstream changes

- `SKILL.md` is adapted: a clearly marked project-specific note adds a web/browser documentation fallback when the Developer Knowledge MCP is not connected and no Google API credential is already available. The upstream skill otherwise remains intact.
- The four reference files and Apache-2.0 license are copied from the pinned upstream commit without edits.
- `AGENTS.md` and `unified-gmail-hub-development/SKILL.md` are project-specific guidance authored for this repository; they are not Google's upstream work.

## Updating

Do not blindly run `npx skills update` over this manually vendored copy. To update safely:

1. Inspect the upstream commit and changes to this exact skill folder.
2. Review the changed instructions and references for compatibility with this project.
3. Update the vendored files and this provenance record together.
4. Preserve the Apache-2.0 license and prominent notices on modified files.
5. Run the repository CI workflow.

Upstream skills are documentation and instructions for coding agents. They do not add runtime dependencies to the Worker and do not guarantee that a model cannot hallucinate.
