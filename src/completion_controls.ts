import * as vscode from 'vscode';

import { CompletionStateController } from './completion_state';
import { formatLocalTime } from './time';

const snoozeAction = 'Snooze 30 Minutes';
const disableAction = 'Disable Completions';
const enableAction = 'Enable Completions';
const resumeAction = 'Resume Now';

export async function showCompletionControls(completionState: CompletionStateController) {
    if (!completionState.isEnabled()) {
        const selection = await vscode.window.showInformationMessage(
            'TabRocket completions are disabled.',
            enableAction,
        );

        if (selection === enableAction) {
            await completionState.enable();
        }

        return;
    }

    if (completionState.isSnoozed()) {
        const selection = await vscode.window.showInformationMessage(
            `TabRocket completions are snoozed until ${formatLocalTime(completionState.getSnoozeUntil())}.`,
            resumeAction,
            disableAction,
        );

        if (selection === resumeAction) {
            await completionState.enable();
        }

        if (selection === disableAction) {
            await completionState.disable();
        }

        return;
    }

    const selection = await vscode.window.showInformationMessage(
        'TabRocket completions are enabled.',
        snoozeAction,
        disableAction,
    );

    if (selection === snoozeAction) {
        await completionState.snooze(30);
    }

    if (selection === disableAction) {
        await completionState.disable();
    }
}
