# Sprint 05 Notes

- Added four read-only system roles in `modules/sub-agents/roles/`: `prep-archivist`, `prep-whitelist`, `strateg-planer`, `strateg-sumarizer`.
- Removed 2026-05-16 cleanup: `prep-archivist` was replaced by `prep-memory` after Memory v3.
- `SubAgentLoader.loadSystemRoles()` loads bundled roles alongside vault custom YAML.
- Custom `SUB_AGENT.yaml` now supports `scope.folders`, `scope.frontmatter`, `scope.sections`, and `scope.pinned_notes`.
- Researcher `max_tool_result_length` default is unified at `15000`.
- `DelegateTool` creates a runner per execution, supports `aspect_explicit`, and applies a 60s per-task timeout.
