import * as vscode from 'vscode';

import { TabRocketApiKeyStore } from './api_key_storage';
import { CompletionStateController } from './completion_state';
import { formatLocalTime } from './time';

const snoozeAction = 'Snooze 30 Minutes';
const disableAction = 'Disable Completions';
const enableAction = 'Enable Completions';
const resumeAction = 'Resume Now';
const setApiKeyAction = 'Set API Key';

export async function showCompletionControls(completionState: CompletionStateController, apiKeyStore: TabRocketApiKeyStore) {
    if (!completionState.isEnabled()) {
        const selection = await vscode.window.showInformationMessage(
            'TabRocket completions are disabled.',
            enableAction,
            setApiKeyAction,
        );

        if (selection === enableAction) {
            await completionState.enable();
        }

        if (selection === setApiKeyAction) {
            await apiKeyStore.promptForApiKey();
        }

        return;
    }

    if (completionState.isSnoozed()) {
        const selection = await vscode.window.showInformationMessage(
            `TabRocket completions are snoozed until ${formatLocalTime(completionState.getSnoozeUntil())}.`,
            resumeAction,
            disableAction,
            setApiKeyAction,
        );

        if (selection === resumeAction) {
            await completionState.enable();
        }

        if (selection === disableAction) {
            await completionState.disable();
        }

        if (selection === setApiKeyAction) {
            await apiKeyStore.promptForApiKey();
        }

        return;
    }

    const selection = await vscode.window.showInformationMessage(
        'TabRocket completions are enabled.',
        snoozeAction,
        disableAction,
        setApiKeyAction,
    );

    if (selection === snoozeAction) {
        await completionState.snooze(30);
    }

    if (selection === disableAction) {
        await completionState.disable();
    }

    if (selection === setApiKeyAction) {
        await apiKeyStore.promptForApiKey();
    }
}
