# Changelog

## 0.2.4

- Discover models through the configured Codex app-server's live `model/list` endpoint instead of the build-time bundled catalog.
- Follow model-list pagination and preserve each model's supported reasoning efforts, including Ultra.
- Add GPT-6 models to the fallback list and document how to select the current CLI when multiple installations exist.

## 0.2.3

- Let selected-text rewrites use the configured preceding and following context windows while limiting accepted edits to the selected range.
- Clarified that Alt+\\ can rewrite any selected text, including individual sentences.

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
