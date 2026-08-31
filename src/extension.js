'use strict';

const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const { CodexCliClient, CodexCliError } = require('./codexClient');
const {
  cleanCompletion,
  cleanRewrite,
  hasEnoughContext,
  isInLatexComment
} = require('./context');
const { buildCompletionPrompt, buildRewritePrompt } = require('./prompt');

const CONFIGURATION_SECTION = 'academicInline';
const MAX_INLINE_WORDS = 50;
const PREVIEW_SCHEME = 'academic-inline-preview';
const REWRITE_ACTIVE_CONTEXT = 'academicInline.rewritePreviewActive';
const GENERIC_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let activeClient;

function getConfiguration(document) {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, document?.uri);
}

function boundedContext(document, position, maxPrefixCharacters, maxSuffixCharacters) {
  const offset = document.offsetAt(position);
  const lastLine = document.lineAt(document.lineCount - 1);
  const documentLength = document.offsetAt(lastLine.range.end);
  const prefixStart = document.positionAt(Math.max(0, offset - maxPrefixCharacters));
  const suffixEnd = document.positionAt(Math.min(documentLength, offset + maxSuffixCharacters));

  return {
    beforeCursor: document.getText(new vscode.Range(prefixStart, position)),
    afterCursor: document.getText(new vscode.Range(position, suffixEnd))
  };
}

function boundedSelectionContext(document, range, maximumCharacters = 1200) {
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  return {
    beforeSelection: document.getText(new vscode.Range(
      document.positionAt(Math.max(0, startOffset - maximumCharacters)),
      range.start
    )),
    afterSelection: document.getText(new vscode.Range(
      range.end,
      document.positionAt(Math.min(document.getText().length, endOffset + maximumCharacters))
    ))
  };
}

function resolveWorkingDirectory(document, configuredDirectory) {
  if (configuredDirectory.trim()) {
    return path.resolve(configuredDirectory.trim());
  }
  if (document.uri.scheme === 'file') {
    return path.dirname(document.uri.fsPath);
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    || vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
  return workspaceFolder?.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
}

function delay(milliseconds, token) {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let cancellation;
    const finish = (ready) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancellation?.dispose();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(true), milliseconds);
    cancellation = token.onCancellationRequested(() => finish(false));
  });
}

function isCancellation(error) {
  return error instanceof CodexCliError && error.message.includes('cancelled');
}

function logSafeError(outputChannel, error) {
  outputChannel.appendLine(`[error] ${error.message}`);
  if (error instanceof CodexCliError && error.details) {
    outputChannel.appendLine(
      '[info] Codex diagnostic output was omitted because it may contain document text.'
    );
  }
}

function createProvider(client, outputChannel) {
  let cachedKey = '';
  let cachedCompletion = '';

  return {
    async provideInlineCompletionItems(document, position, context, token) {
      const configuration = getConfiguration(document);
      const isManual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

      if (!configuration.get('enabled', true)) {
        return [];
      }
      if (!isManual && !configuration.get('automaticSuggestions', true)) {
        return [];
      }
      const allowedLanguages = configuration.get('allowedLanguages', []);
      if (!allowedLanguages.includes(document.languageId)) {
        return [];
      }
      const editor = vscode.window.activeTextEditor;
      if (editor?.document === document && !editor.selection.isEmpty) {
        return [];
      }

      const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
      if (
        !isManual
        && document.languageId === 'latex'
        && configuration.get('disableInLatexComments', true)
        && isInLatexComment(linePrefix)
      ) {
        return [];
      }

      const documentContext = boundedContext(
        document,
        position,
        configuration.get('maxPrefixCharacters', 6000),
        configuration.get('maxSuffixCharacters', 1500)
      );
      if (
        !isManual
        && !hasEnoughContext(
          documentContext.beforeCursor,
          configuration.get('minimumContextCharacters', 24)
        )
      ) {
        return [];
      }

      if (!isManual) {
        const ready = await delay(configuration.get('debounceMilliseconds', 350), token);
        if (!ready || token.isCancellationRequested) {
          return [];
        }
      }

      const maximumWords = isManual
        ? Number.POSITIVE_INFINITY
        : Math.min(configuration.get('maximumWords', MAX_INLINE_WORDS), MAX_INLINE_WORDS);
      const cacheKey = [
        document.uri.toString(),
        document.version,
        document.offsetAt(position),
        configuration.get('model', ''),
        configuration.get('reasoningEffort', 'low'),
        configuration.get('englishVariant', 'preserve'),
        maximumWords,
        configuration.get('customInstructions', '')
      ].join('|');
      if (cacheKey === cachedKey && cachedCompletion) {
        return [{ insertText: cachedCompletion, range: new vscode.Range(position, position) }];
      }

      const prompt = buildCompletionPrompt({
        ...documentContext,
        languageId: document.languageId,
        fileName: path.basename(document.fileName || document.uri.path || 'untitled'),
        maximumWords,
        englishVariant: configuration.get('englishVariant', 'preserve'),
        customInstructions: configuration.get('customInstructions', '')
      });
      const abortController = new AbortController();
      const cancellation = token.onCancellationRequested(() => abortController.abort());

      try {
        const rawCompletion = await client.complete({
          cliPath: configuration.get('codexPath', 'codex'),
          cwd: resolveWorkingDirectory(document, configuration.get('workingDirectory', '')),
          model: configuration.get('model', '').trim(),
          reasoningEffort: configuration.get('reasoningEffort', 'low'),
          prompt,
          timeoutMilliseconds: 0,
          signal: abortController.signal,
          allowWorkspaceRead: configuration.get('allowWorkspaceRead', false)
        });
        if (token.isCancellationRequested) {
          return [];
        }

        const completion = cleanCompletion(
          rawCompletion,
          documentContext.beforeCursor,
          documentContext.afterCursor,
          Number.isFinite(maximumWords) ? maximumWords * 24 : Number.POSITIVE_INFINITY,
          maximumWords
        );
        if (!completion) {
          return [];
        }
        cachedKey = cacheKey;
        cachedCompletion = completion;
        return [{ insertText: completion, range: new vscode.Range(position, position) }];
      } catch (error) {
        if (isCancellation(error)) {
          return [];
        }
        logSafeError(outputChannel, error);
        if (isManual) {
          void vscode.window.showWarningMessage(
            `Academic Inline could not generate a suggestion: ${error.message}`,
            'Show Logs'
          ).then((choice) => {
            if (choice === 'Show Logs') {
              outputChannel.show(true);
            }
          });
        }
        return [];
      } finally {
        cancellation.dispose();
      }
    }
  };
}

async function loadModels(client, configuration, outputChannel) {
  try {
    return await client.listModels({
      cliPath: configuration.get('codexPath', 'codex'),
      timeoutMilliseconds: 10000
    });
  } catch (error) {
    outputChannel.appendLine(`[warning] Could not read Codex model catalog: ${error.message}`);
    return configuration.get('fallbackModels', []).map((id) => ({
      id,
      label: id,
      description: '',
      reasoningEfforts: []
    }));
  }
}

function configurationTarget() {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function effortLabel(effort) {
  return {
    default: 'Use model default',
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Maximum'
  }[effort] || effort;
}

function effortDetail(effort) {
  return {
    default: 'Inherit the Codex configuration',
    none: 'Fastest; no additional reasoning',
    minimal: 'Very fast; minimal reasoning',
    low: 'Fast reasoning, recommended for inline writing',
    medium: 'Balanced speed and reasoning depth',
    high: 'Deeper reasoning for difficult rewriting',
    xhigh: 'Very deep reasoning for complex requests',
    max: 'Maximum available reasoning depth'
  }[effort] || '';
}

async function selectReasoningEffort(statusBar, supportedEfforts) {
  const configuration = getConfiguration(vscode.window.activeTextEditor?.document);
  const current = configuration.get('reasoningEffort', 'low');
  const supported = supportedEfforts?.length ? supportedEfforts : GENERIC_REASONING_EFFORTS;
  const efforts = ['default', ...supported.filter((value, index) => supported.indexOf(value) === index)];
  const selection = await vscode.window.showQuickPick(
    efforts.map((effort) => ({
      label: effortLabel(effort),
      description: effort === current ? 'Current' : '',
      detail: effortDetail(effort),
      effort
    })),
    { placeHolder: 'Choose Codex reasoning strength', matchOnDetail: true }
  );
  if (!selection) {
    return false;
  }
  await configuration.update('reasoningEffort', selection.effort, configurationTarget());
  updateStatusBar(statusBar);
  vscode.window.showInformationMessage(
    `Academic Inline reasoning strength: ${effortLabel(selection.effort)}.`
  );
  return true;
}

async function selectModel(client, statusBar, outputChannel) {
  const configuration = getConfiguration(vscode.window.activeTextEditor?.document);
  const models = await loadModels(client, configuration, outputChannel);
  const currentModel = configuration.get('model', '');
  const items = [
    {
      label: '$(settings) Use Codex default',
      description: currentModel ? '' : 'Current',
      modelId: '',
      reasoningEfforts: GENERIC_REASONING_EFFORTS
    },
    ...models.map((model) => ({
      label: model.label,
      description: model.id === currentModel ? 'Current' : model.id,
      detail: model.description,
      modelId: model.id,
      reasoningEfforts: model.reasoningEfforts
    })),
    { label: '$(edit) Enter a custom model ID...', modelId: undefined }
  ];
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose the Codex model for academic writing',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selection) {
    return;
  }

  let modelId = selection.modelId;
  if (modelId === undefined) {
    modelId = await vscode.window.showInputBox({
      title: 'Academic Inline model',
      prompt: 'Enter a model ID accepted by your Codex CLI',
      value: currentModel,
      validateInput: (value) => value.trim() ? undefined : 'Enter a model ID.'
    });
    if (modelId === undefined) {
      return;
    }
    modelId = modelId.trim();
  }

  await configuration.update('model', modelId, configurationTarget());
  updateStatusBar(statusBar);
  await selectReasoningEffort(statusBar, selection.reasoningEfforts);
}

function updateStatusBar(statusBar) {
  const configuration = getConfiguration(vscode.window.activeTextEditor?.document);
  if (!configuration.get('showStatusBar', true)) {
    statusBar.hide();
    return;
  }
  const enabled = configuration.get('enabled', true);
  const model = configuration.get('model', '') || 'Codex default';
  const effort = effortLabel(configuration.get('reasoningEffort', 'low'));
  statusBar.text = enabled
    ? `$(sparkle) Academic: ${model} · ${effort}`
    : '$(circle-slash) Academic: Off';
  statusBar.tooltip = enabled
    ? `Academic Inline uses ${model} with ${effort.toLowerCase()} strength. Click to change both.`
    : 'Academic Inline is disabled. Use the command palette to enable it.';
  statusBar.show();
}

async function toggleEnabled(statusBar) {
  const configuration = getConfiguration(vscode.window.activeTextEditor?.document);
  const nextValue = !configuration.get('enabled', true);
  await configuration.update('enabled', nextValue, configurationTarget());
  updateStatusBar(statusBar);
  vscode.window.showInformationMessage(`Academic Inline ${nextValue ? 'enabled' : 'disabled'}.`);
}

class RewritePreviewProvider {
  constructor() {
    this.content = new Map();
  }

  provideTextDocumentContent(uri) {
    return this.content.get(uri.toString()) || '';
  }

  create(original, rewritten, extension) {
    const id = randomUUID();
    const originalUri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: `/${id}/original${extension}`
    });
    const rewrittenUri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: `/${id}/rewritten${extension}`
    });
    this.content.set(originalUri.toString(), original);
    this.content.set(rewrittenUri.toString(), rewritten);
    return { originalUri, rewrittenUri };
  }

  dispose() {
    this.content.clear();
  }
}

class RewriteDecisionController {
  constructor() {
    this.pending = undefined;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.statusBar.name = 'Academic Rewrite Decision';
    this.statusBar.text = '$(check) Tab: Accept Rewrite  ·  Esc: Reject';
    this.statusBar.tooltip = 'While the rewrite diff is focused, press Tab to accept or Escape to reject.';
    this.statusBar.command = 'academicInline.acceptRewrite';
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  async present(pending) {
    this.pending = pending;
    this.statusBar.show();
    await vscode.commands.executeCommand('setContext', REWRITE_ACTIVE_CONTEXT, true);
  }

  async closePreviewIfFocused() {
    if (vscode.window.activeTextEditor?.document.uri.scheme === PREVIEW_SCHEME) {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  }

  async clear() {
    this.pending = undefined;
    this.statusBar.hide();
    await vscode.commands.executeCommand('setContext', REWRITE_ACTIVE_CONTEXT, false);
  }

  async accept() {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const { document, documentVersion, range, originalText, rewrittenText } = pending;
    if (document.version !== documentVersion || document.getText(range) !== originalText) {
      await this.clear();
      await this.closePreviewIfFocused();
      vscode.window.showWarningMessage(
        'The document changed while the diff was open, so Academic Inline did not apply it.'
      );
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, rewrittenText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showWarningMessage('VS Code could not apply the rewrite.');
      return;
    }
    await this.clear();
    await this.closePreviewIfFocused();
    vscode.window.setStatusBarMessage('$(check) Academic rewrite accepted.', 2500);
  }

  async reject() {
    if (!this.pending) {
      return;
    }
    await this.clear();
    await this.closePreviewIfFocused();
    vscode.window.setStatusBarMessage('$(x) Academic rewrite rejected.', 2500);
  }

  dispose() {
    this.pending = undefined;
    this.statusBar.dispose();
    void vscode.commands.executeCommand('setContext', REWRITE_ACTIVE_CONTEXT, false);
  }
}

async function rewriteSelection(client, previewProvider, decisionController, outputChannel) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select a paragraph first, then press Alt+\\.');
    return;
  }
  const document = editor.document;
  const configuration = getConfiguration(document);
  if (!configuration.get('enabled', true)) {
    vscode.window.showInformationMessage('Academic Inline is disabled for this workspace.');
    return;
  }
  if (!configuration.get('allowedLanguages', []).includes(document.languageId)) {
    vscode.window.showWarningMessage(`Academic Inline is not enabled for ${document.languageId}.`);
    return;
  }

  const range = new vscode.Range(editor.selection.start, editor.selection.end);
  const originalText = document.getText(range);
  if (!originalText.trim()) {
    return;
  }
  const documentVersion = document.version;
  const instruction = await vscode.window.showInputBox({
    title: 'Academic Inline: Rewrite selection',
    prompt: 'Describe how the selected paragraph should be rewritten',
    placeHolder: 'For example: make it more concise and clarify the causal argument',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter a rewrite request.'
  });
  if (instruction === undefined) {
    return;
  }

  const surrounding = boundedSelectionContext(document, range);
  const prompt = buildRewritePrompt({
    selectedText: originalText,
    ...surrounding,
    instruction: instruction.trim(),
    languageId: document.languageId,
    fileName: path.basename(document.fileName || document.uri.path || 'untitled'),
    englishVariant: configuration.get('englishVariant', 'preserve'),
    customInstructions: configuration.get('customInstructions', '')
  });
  try {
    const rawRewrite = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Academic Inline: rewriting selected text',
      cancellable: true
    }, async (_progress, token) => {
      const abortController = new AbortController();
      const cancellation = token.onCancellationRequested(() => abortController.abort());
      try {
        return await client.complete({
          cliPath: configuration.get('codexPath', 'codex'),
          cwd: resolveWorkingDirectory(document, configuration.get('workingDirectory', '')),
          model: configuration.get('model', '').trim(),
          reasoningEffort: configuration.get('reasoningEffort', 'low'),
          prompt,
          timeoutMilliseconds: 0,
          signal: abortController.signal,
          allowWorkspaceRead: configuration.get('allowWorkspaceRead', false)
        });
      } finally {
        cancellation.dispose();
      }
    });
    const rewrittenCore = cleanRewrite(rawRewrite);
    if (!rewrittenCore) {
      vscode.window.showWarningMessage('Codex returned no replacement text.');
      return;
    }
    const leadingWhitespace = originalText.match(/^\s*/)?.[0] || '';
    const trailingWhitespace = originalText.match(/\s*$/)?.[0] || '';
    const rewrittenText = `${leadingWhitespace}${rewrittenCore}${trailingWhitespace}`;
    if (rewrittenText === originalText) {
      vscode.window.showInformationMessage('Codex did not find a useful change for this selection.');
      return;
    }

    const extension = path.extname(document.fileName || document.uri.path) || '.txt';
    const preview = previewProvider.create(originalText, rewrittenText, extension);
    await vscode.commands.executeCommand(
      'vscode.diff',
      preview.originalUri,
      preview.rewrittenUri,
      'Academic Rewrite: Original ↔ Suggested',
      { preview: true }
    );
    await decisionController.present({
      document,
      documentVersion,
      range,
      originalText,
      rewrittenText,
      preview
    });
  } catch (error) {
    if (isCancellation(error)) {
      return;
    }
    logSafeError(outputChannel, error);
    const choice = await vscode.window.showWarningMessage(
      `Academic Inline could not rewrite the selection: ${error.message}`,
      'Show Logs'
    );
    if (choice === 'Show Logs') {
      outputChannel.show(true);
    }
  }
}

async function checkCodex(client, outputChannel) {
  const configuration = getConfiguration(vscode.window.activeTextEditor?.document);
  try {
    const version = await client.version({ cliPath: configuration.get('codexPath', 'codex') });
    const models = await client.listModels({ cliPath: configuration.get('codexPath', 'codex') });
    outputChannel.appendLine(`[info] ${version}; ${models.length} selectable models found.`);
    vscode.window.showInformationMessage(
      `Academic Inline found ${version} and ${models.length} selectable models.`
    );
  } catch (error) {
    logSafeError(outputChannel, error);
    const choice = await vscode.window.showErrorMessage(
      `Academic Inline could not use Codex: ${error.message}`,
      'Show Logs'
    );
    if (choice === 'Show Logs') {
      outputChannel.show(true);
    }
  }
}

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel('Academic Inline', { log: true });
  const client = new CodexCliClient((message) => outputChannel.appendLine(`[info] ${message}`));
  activeClient = client;
  const previewProvider = new RewritePreviewProvider();
  const decisionController = new RewriteDecisionController();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'academicInline.selectModel';
  statusBar.name = 'Academic Inline';
  const provider = createProvider(client, outputChannel);

  context.subscriptions.push(
    outputChannel,
    statusBar,
    previewProvider,
    decisionController,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previewProvider),
    vscode.languages.registerInlineCompletionItemProvider('*', provider),
    vscode.commands.registerCommand('academicInline.triggerSuggestion', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        await rewriteSelection(client, previewProvider, decisionController, outputChannel);
      } else {
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      }
    }),
    vscode.commands.registerCommand('academicInline.rewriteSelection', () => (
      rewriteSelection(client, previewProvider, decisionController, outputChannel)
    )),
    vscode.commands.registerCommand('academicInline.acceptRewrite', () => (
      decisionController.accept()
    )),
    vscode.commands.registerCommand('academicInline.rejectRewrite', () => (
      decisionController.reject()
    )),
    vscode.commands.registerCommand('academicInline.selectModel', () => (
      selectModel(client, statusBar, outputChannel)
    )),
    vscode.commands.registerCommand('academicInline.selectReasoningEffort', () => (
      selectReasoningEffort(statusBar)
    )),
    vscode.commands.registerCommand('academicInline.toggleEnabled', () => toggleEnabled(statusBar)),
    vscode.commands.registerCommand('academicInline.checkCodex', () => checkCodex(client, outputChannel)),
    vscode.commands.registerCommand('academicInline.showOutput', () => outputChannel.show(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
        updateStatusBar(statusBar);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar(statusBar))
  );

  outputChannel.appendLine(`[info] Academic Inline 0.2.2 activated on ${os.platform()}.`);
  updateStatusBar(statusBar);
}

function deactivate() {
  activeClient?.dispose();
  activeClient = undefined;
}

module.exports = { activate, deactivate };
