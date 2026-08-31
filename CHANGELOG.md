# Changelog

## 0.2.2

- Replaced the temporary rewrite notification with persistent keyboard controls in the diff view.
- Added Tab to accept a rewrite and Escape to reject it, with a status-bar reminder that remains until a decision.

## 0.2.1

- Removed the three-second generation deadline.
- Capped automatic grey inline completions at 50 words while leaving Alt+\\ requests unrestricted.
- Removed time and selection-length limits from Alt+\\ paragraph rewriting; cancellation remains available.

## 0.2.0

- Added a hard three-second generation budget and cancellation for inline and rewrite requests.
- Switched completion generation to a persistent Codex app-server process to remove per-request CLI startup overhead.
- Added model-aware reasoning-strength selection and status-bar display.
- Added Alt+\\ paragraph rewriting with an instruction box, native diff preview, and explicit accept/reject controls.

## 0.1.0

- Added native academic inline completions through `codex exec`.
- Added model selection from the local Codex catalog and custom model IDs.
- Added automatic and manual triggering, bounded context, cancellation, timeout, and completion cleanup.
- Added LaTeX and Overleaf Workshop compatibility.
- Added evidence and citation guardrails based on academic-writing skill guidance.
