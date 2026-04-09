import { Disposable, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { CompletionStateController } from './completion_state';
import { formatLocalTime } from './time';

const idleText = '🚀 TabRocket';
const loadingText = '$(loading~spin) TabRocket';
const errorText = '$(error) TabRocket';
const disabledText = '$(circle-slash) TabRocket';
const snoozedText = '$(clock) TabRocket';

export class TabRocketStatusBar implements Disposable {
    private readonly statusBarItem: StatusBarItem;
    private readonly stateListener: Disposable;
    private mode: 'idle' | 'loading' | 'error' | 'forbidden' = 'idle';
    private errorMessage: string | undefined;
    private forbiddenMessage: string | undefined;

    constructor(command: string, private readonly completionState: CompletionStateController) {
        this.statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right);
        this.statusBarItem.command = command;
        this.stateListener = this.completionState.onDidChangeState(() => this.refresh());
        this.showIdle();
        this.statusBarItem.show();
    }

    showIdle() {
        this.mode = 'idle';
        this.errorMessage = undefined;
        this.forbiddenMessage = undefined;
        this.refresh();
    }

    showLoading() {
        this.mode = 'loading';
        this.errorMessage = undefined;
        this.forbiddenMessage = undefined;
        this.refresh();
    }

    showError(message: string) {
        this.mode = 'error';
        this.errorMessage = message;
        this.forbiddenMessage = undefined;
        this.refresh();
    }

    showForbidden(message: string) {
        this.mode = 'forbidden';
        this.errorMessage = undefined;
        this.forbiddenMessage = message;
        this.refresh();
    }

    private refresh() {
        if (!this.completionState.isEnabled()) {
            this.statusBarItem.text = disabledText;
            this.statusBarItem.tooltip = 'Disabled. Click for controls.';
            return;
        }

        if (this.completionState.isSnoozed()) {
            this.statusBarItem.text = snoozedText;
            this.statusBarItem.tooltip = `Snoozed until ${formatLocalTime(this.completionState.getSnoozeUntil())}. Click for controls.`;
            return;
        }

        if (this.mode === 'error' && this.errorMessage) {
            this.statusBarItem.text = errorText;
            this.statusBarItem.tooltip = 'Error. Click for controls.';
            return;
        }

        if (this.mode === 'loading') {
            this.statusBarItem.text = loadingText;
            this.statusBarItem.tooltip = 'Working... Click for controls.';
            return;
        }

        if (this.mode === 'forbidden' && this.forbiddenMessage) {
            this.statusBarItem.text = disabledText;
            this.statusBarItem.tooltip = 'Disabled. Click for controls.';
            return;
        }

        this.statusBarItem.text = idleText;
        this.statusBarItem.tooltip = 'Ready! Click for controls.';
    }
    dispose() {
        this.stateListener.dispose();
        this.statusBarItem.dispose();
    }
}
