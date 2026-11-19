# Repository-wide instructions for AI coding agents

For any code task in this repository, follow `.agents/skills/unified-gmail-hub-development/SKILL.md`. For Google API research, also use `.agents/skills/retrieving-developer-knowledge/SKILL.md` when relevant.

## Non-negotiable grounding rules

- Inspect the current branch's implementation before answering or editing. Conversation history and remembered plans are not a substitute for current code.
- Verify Google API and OAuth details against current official Google documentation; verify Cloudflare behavior against current official Cloudflare documentation.
- Never invent endpoints, OAuth scopes, request/response fields, quotas, limits, deployment settings, or test outcomes.
- Clearly separate verified facts, assumptions, hypotheses, and items that could not be checked.
- Do not claim a production change is live without checking the deployed Worker/version and its bindings or relevant live state.
- Keep the Worker architecture on Cloudflare unless a migration is explicitly requested.
- Protect credentials, user mailbox data, and production D1 records. Make the smallest safe change and add regression tests.

See the project skill for the verified architecture, evidence hierarchy, debugging workflow, commands, and security constraints.
