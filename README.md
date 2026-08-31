# Academic Inline

Academic Inline is a VS Code extension for Copilot-style academic writing assistance. It reads a bounded window around the cursor, asks your locally authenticated Codex CLI for a short continuation, and displays the result as VS Code's native grey inline text.

Press **Tab** to accept a visible suggestion or **Escape** to dismiss it. Press **Alt+\\** with no selection to request one manually. Select a paragraph and press **Alt+\\** to request an instructed rewrite with a diff and accept/reject choice.

## Features

- Native grey inline completions in LaTeX, Markdown, plain text, and reStructuredText.
- Automatic suggestions after a configurable typing pause.
- Manual suggestions with **Alt+\\** or `Academic Inline: Trigger Suggestion`.
- A combined model and reasoning-strength picker populated from the model catalog bundled with your installed Codex CLI.
- Automatic grey inline completions capped at 50 words, without a generation deadline. Alt+\\ requests are unrestricted.
- Instruction-driven paragraph rewriting with VS Code's native diff viewer and explicit accept/reject controls.
- Evidence-aware academic prompting that preserves terminology and avoids invented citations, data, authors, results, and bibliography keys.
- LaTeX-safe output and automatic suppression inside LaTeX comments.
- Overleaf Workshop support for both local and virtual project documents.
- No API key stored by the extension. Authentication is handled by Codex.

## Download

Download the newest `academic-inline-*.vsix` file from [GitHub Releases](https://github.com/HG-KaiBai/academic-inline/releases/latest). Do not download the repository's source ZIP unless you intend to build the extension yourself.

## Requirements

- Visual Studio Code 1.96 or newer.
- A current Codex CLI installation and a ChatGPT account that can use Codex.
- VS Code's built-in `editor.inlineSuggest.enabled` setting enabled.

The extension uses your local Codex authentication; it does not ask for or store an API key. See the [official Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli) for current installation and authentication options.

## Windows installation

### 1. Install and sign in to Codex

Install [Node.js](https://nodejs.org/) if `npm` is not already available, then run in PowerShell:

```powershell
npm install -g @openai/codex
codex
```

Complete **Sign in with ChatGPT** the first time Codex starts, then exit Codex and verify:

```powershell
codex --version
```

If Codex came with the Codex desktop app and already works in PowerShell, you can skip the npm installation.

### 2. Install Academic Inline

Download the VSIX from [the latest release](https://github.com/HG-KaiBai/academic-inline/releases/latest). In VS Code, open **Extensions**, select the `...` menu, choose **Install from VSIX...**, select the downloaded file, and reload VS Code.

Alternatively, if the `code` command is on PATH:

```powershell
code --install-extension "$HOME\Downloads\academic-inline-0.2.2.vsix" --force
```

## macOS installation

### 1. Install and sign in to Codex

Open Terminal and use the official Codex installer:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Complete **Sign in with ChatGPT** the first time Codex starts, then exit Codex and verify:

```bash
codex --version
```

You may instead install with npm if you already use Node.js:

```bash
npm install -g @openai/codex
```

### 2. Install Academic Inline

Download the VSIX from [the latest release](https://github.com/HG-KaiBai/academic-inline/releases/latest). In VS Code, open **Extensions**, select the `...` menu, choose **Install from VSIX...**, select the downloaded file, and reload VS Code.

For terminal installation, first run **Shell Command: Install 'code' command in PATH** from the VS Code command palette, then run:

```bash
code --install-extension "$HOME/Downloads/academic-inline-0.2.2.vsix" --force
```

## Verify the installation

Run `Academic Inline: Check Codex CLI` from the VS Code command palette. If Codex is installed somewhere unusual, set `academicInline.codexPath` to its full executable path.

## Use

Open a `.tex`, Markdown, text, or reStructuredText document and continue writing. After the configured pause, Academic Inline uses the persistent `codex app-server` process and returns one short continuation. VS Code renders it as grey text.

- **Tab** accepts the visible suggestion using VS Code's standard inline-suggestion binding.
- **Escape** dismisses it.
- **Alt+\\** with no selection explicitly triggers a grey suggestion, including in places with less than the automatic minimum context.
- Select a paragraph and press **Alt+\\**, then enter a short instruction such as `make this concise and clarify the causal argument`. In the native diff, press **Tab** to accept or **Escape** to reject. A persistent status-bar reminder stays visible until you decide. The source document is unchanged until you accept.
- Click the `Academic: ... · ...` status-bar item to select both a model and reasoning strength.
- Use `Academic Inline: Enable/Disable` to toggle the extension for the current workspace.

## Overleaf Workshop

Academic Inline registers its completion provider for every VS Code document scheme, then checks the document's language ID. This means it can read an Overleaf Workshop virtual document through VS Code's `TextDocument` API without needing direct access to the Overleaf server or its filesystem.

For an Overleaf document, confirm that the language indicator in the lower-right corner says `LaTeX`. If an Overleaf extension uses a different language ID, add it to `academicInline.allowedLanguages`.

The text is still passed directly through the VS Code document API even when it has no local filesystem path. Codex runs in an empty temporary directory unless you explicitly enable `academicInline.allowWorkspaceRead`.

## Model selection

Run `Academic Inline: Select Model and Strength` or click the status-bar item. The first picker asks `codex debug models --bundled` for the models available in your installed CLI. Choose `Use Codex default` to inherit the model in your Codex configuration, or enter any custom model ID accepted by your installation. The second picker shows the strengths supported by that model. You can also run `Academic Inline: Select Reasoning Strength` independently.

`academicInline.reasoningEffort` defaults to `low` because inline completion is latency-sensitive. Medium, high, extra-high, and maximum settings can improve difficult work and are allowed to finish without a generation deadline.

## Important settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `academicInline.enabled` | `true` | Enables suggestions. |
| `academicInline.automaticSuggestions` | `true` | Runs after typing pauses. |
| `academicInline.model` | empty | Uses the Codex-configured model. |
| `academicInline.reasoningEffort` | `low` | Controls latency and reasoning depth. |
| `academicInline.debounceMilliseconds` | `350` | Delay after typing before an automatic request. |
| `academicInline.maxPrefixCharacters` | `6000` | Context before the cursor. |
| `academicInline.maxSuffixCharacters` | `1500` | Context after the cursor. |
| `academicInline.maximumWords` | `50` | Maximum automatic inline length; Alt+\\ requests are unrestricted. |
| `academicInline.englishVariant` | `preserve` | Preserves, British, or American spelling. |
| `academicInline.customInstructions` | empty | Adds discipline or style guidance. |
| `academicInline.allowWorkspaceRead` | `false` | Opts into read-only access to a local document/workspace folder. |

## Privacy and safety

By default, each request exposes only the configured context window and metadata such as the language ID and filename to the locally installed Codex CLI. A persistent app-server process avoids paying CLI startup cost for every keystroke, while each writing request uses a fresh ephemeral Codex thread in a new empty temporary directory. The extension does not record document content or raw Codex error streams. Threads use a read-only sandbox, deny approvals, and ask Codex to return text without tools.

`academicInline.allowWorkspaceRead` is an explicit opt-in for users who want Codex to see local project files. When enabled, the process runs from `academicInline.workingDirectory`, the document folder, or a local workspace folder, and the read-only sandbox can inspect files there.

The content still leaves VS Code through your authenticated Codex service. Apply your institution's data-handling policy before using unpublished, confidential, personal, or restricted material.

Inline text can sound plausible while being wrong. Review every accepted completion, especially factual claims, citations, equations, and interpretations. The prompt refuses to fabricate evidence, but that is a guardrail rather than a guarantee.

## Academic writing guidance

The completion prompt adapts principles from the Academic Writing Toolkit and the open-source [research-writing-skill](https://github.com/zLanqing/codex-claude-academic-skills/tree/main/research-writing-skill): preserve the author's intended meaning and terminology, tie claims to available evidence, prefer verifiable statements over vague evaluation, follow each manuscript section's rhetorical purpose, and never invent data or references.

## Development

The extension is dependency-free at runtime and uses CommonJS so it can be launched directly in an Extension Development Host.

```powershell
npm test
npm run check
npx @vscode/vsce package --allow-missing-repository
```

Press **F5** in this folder to launch an Extension Development Host. Open a writing document there, then run `Academic Inline: Check Codex CLI` before testing a completion.

## Troubleshooting

- No grey text: check `editor.inlineSuggest.enabled`, the document language ID, and `academicInline.enabled`.
- `Codex CLI` error: run `Academic Inline: Check Codex CLI`, then inspect `Academic Inline: Show Logs`.
- Slow suggestions: choose a faster model or lower reasoning strength. Manual Alt+\\ and selected-text rewrites have no generation deadline, but you can cancel a rewrite from its progress notification.
- No suggestion in a LaTeX comment: use **Alt+\\** manually or disable `academicInline.disableInLatexComments`.
- Tab inserts indentation: a suggestion must be visible, and no other extension should override `editor.action.inlineSuggest.commit`.

## License

MIT
