import * as vscode from 'vscode';

import { TabRocketApiKeyStore } from './api_key_storage';
import { showCompletionControls } from './completion_controls';
import { CompletionStateController } from './completion_state';
import { configurationSection } from './config';
import { CompletionProvider } from './completion_provider';
import { bindChannel, log } from './logger';
import { TabRocketStatusBar } from './status_bar';

const manageCompletionsCommand = 'tabRocket.manageCompletions';
const setApiKeyCommand = 'tabRocket.setApiKey';
const clearApiKeyCommand = 'tabRocket.clearApiKey';

export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('TabRocket');
	const apiKeyStore = new TabRocketApiKeyStore(context.secrets);
	const completionState = new CompletionStateController(context.globalState);
	const statusBar = new TabRocketStatusBar(manageCompletionsCommand, completionState);
	const provider = new CompletionProvider(statusBar, completionState, apiKeyStore, context.extension.packageJSON.version);

	context.subscriptions.push(
		outputChannel,
		apiKeyStore.onDidChange(() => {
			void provider.refreshConfig();
		}),
		bindChannel(outputChannel),
		completionState,
		statusBar,
		provider,
		vscode.commands.registerCommand(manageCompletionsCommand, async () => {
			await showCompletionControls(completionState);
		}),
		vscode.commands.registerCommand(setApiKeyCommand, async () => {
			await apiKeyStore.promptForApiKey();
		}),
		vscode.commands.registerCommand(clearApiKeyCommand, async () => {
			await apiKeyStore.clear();
			void vscode.window.showInformationMessage('TabRocket API key cleared.');
		}),
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			provider,
		),
		vscode.window.onDidChangeTextEditorSelection((e) => {
			provider.cursorMoveEvent(e);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(configurationSection)) {
				void provider.refreshConfig();
			}
		}),
	);

	await provider.refreshConfig();
	log('TabRocket Ignition!');
}

export function deactivate() { }
