import OpenAI, {
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIUserAbortError,
} from 'openai';
import {
    CancellationToken,
    Disposable,
    InlineCompletionContext,
    InlineCompletionItem,
    InlineCompletionItemProvider,
    InlineCompletionList,
    Position,
    Range,
    Selection,
    TextDocument,
    TextEditorSelectionChangeEvent,
    TextEditorSelectionChangeKind,
    window,
    workspace,
} from 'vscode';
import { TabRocketApiKeyStore } from './api_key_storage';
import { CompletionRequest } from './completion_request';
import { CompletionStateController } from './completion_state';
import { getTabRocketConfig, TabRocketConfig } from './config';
import { getMatchingForbiddenPattern } from './forbidden_files';
import { log } from './logger';
import { PendingCompletion } from './pending_completion';
import { TabRocketStatusBar } from './status_bar';
import { performance } from 'perf_hooks';

class Completion {
    completionText: string;
    startPosition: Position;
    toLineEnd: boolean;

    constructor(completionText: string, startPosition: Position, toLineEnd: boolean) {
        this.completionText = completionText;
        this.startPosition = startPosition;
        this.toLineEnd = toLineEnd;
    }

    public stillValid(document: TextDocument, position: Position): boolean {
        if (position.line !== this.startPosition.line) {
            return false;
        }

        if (position.character < this.startPosition.character) {
            return false;
        }
        if (position.character === this.startPosition.character) {
            return true;
        }

        const typedPrefix = document.getText(new Range(this.startPosition, position));
        if (typedPrefix === this.completionText) {
            return false;
        }
        return this.completionText.startsWith(typedPrefix);
    }
}

export function createInlineCompletionItem(document: TextDocument, completion: Completion, position: Position): InlineCompletionItem {
    const range = new Range(
        completion.startPosition,
        completion.toLineEnd ? document.lineAt(completion.startPosition.line).range.end : position,
    );

    const item = new InlineCompletionItem(completion.completionText, range);

    const replacedText = document.getText(range);
    if (replacedText.length > 0 && !completion.completionText.startsWith(replacedText)) {
        item.filterText = replacedText + completion.completionText;
    }

    return item;
}

const setApiKeyAction = 'Set API Key';

export class CompletionProvider implements InlineCompletionItemProvider, Disposable {
    client: OpenAI;
    config: TabRocketConfig;
    userAgent: string;
    statusBar: TabRocketStatusBar;
    completionState: CompletionStateController;
    pendingCompletion: PendingCompletion | null = null;
    inflightCompletion: CompletionRequest | null = null;
    activeCompletion: Completion | null = null;
    prevPosition: Position | null = null;
    lastErrorMessage: string | null = null;
    private readonly stateListener: Disposable;
    private readonly apiKeyStore: TabRocketApiKeyStore;
    nextRequestTime: number;

    constructor(statusBar: TabRocketStatusBar, completionState: CompletionStateController, apiKeyStore: TabRocketApiKeyStore, extensionVersion: string) {
        this.config = getTabRocketConfig();
        this.userAgent = `TabRocket:${extensionVersion}`;
        this.apiKeyStore = apiKeyStore;
        this.client = this.createClient(this.config, '');
        this.statusBar = statusBar;
        this.completionState = completionState;
        this.stateListener = this.completionState.onDidChangeState(() => {
            this.lastErrorMessage = null;
            this.cancelActiveRequests();
            this.statusBar.showIdle();
        });
        this.nextRequestTime = performance.now();
    }

    private setNextRequestTime(): void {
        this.nextRequestTime = performance.now() + this.config.debounceMs;
    }

    private createClient(config: TabRocketConfig, apiKey: string): OpenAI {
        return new OpenAI({
            baseURL: config.baseUrl,
            apiKey: apiKey || 'tab-rocket',
            defaultHeaders: {
                'User-Agent': this.userAgent,
            },
        });
    }

    public async refreshConfig() {
        this.cancelActiveRequests();
        this.lastErrorMessage = null;
        this.config = getTabRocketConfig();
        this.client = this.createClient(this.config, await this.apiKeyStore.get());
        log('Updated configuration');
    }

    private sendToPendingCompletion(request: CompletionRequest, ms: number) {
        this.pendingCompletion = new PendingCompletion(request, () => {
            request.cancel();
            this.pendingCompletion = null;
        }, ms);
    }

    private takePendingCompletion(): CompletionRequest | null {
        const pendingCompletion = this.pendingCompletion;
        if (pendingCompletion === null) {
            return null;
        }

        this.pendingCompletion = null;
        return pendingCompletion.cancelCancellation();
    }

    private newCompletionRequest(document: TextDocument, position: Position): CompletionRequest {
        return new CompletionRequest(
            this.client,
            this.config,
            document,
            position,
            this.nextRequestTime,
            () => this.setNextRequestTime()
        );
    }

    private getOrCreateRequest(document: TextDocument, position: Position): CompletionRequest {
        const pendingRequest = this.takePendingCompletion();
        if (pendingRequest === null) {
            return this.newCompletionRequest(document, position);
        }

        if (pendingRequest.completionPositionStart.line === position.line
            && pendingRequest.completionPositionStart.character <= position.character) {
            return pendingRequest;
        }

        pendingRequest.cancel();
        return this.newCompletionRequest(document, position);
    }

    private async resolveRequest(
        request: CompletionRequest,
        token: CancellationToken,
    ): Promise<Completion | null> {
        this.statusBar.showLoading();
        let hasRequestError = false;
        this.inflightCompletion = request;

        try {
            const completionText = await Promise.race([
                request.wait(),
                new Promise<null>((resolve) => token.onCancellationRequested(() => resolve(null))),
            ]);

            this.inflightCompletion = null;
            if (!this.completionState.shouldProvideCompletions()) {
                request.cancel();
                return null;
            }

            if (token.isCancellationRequested) {
                this.sendToPendingCompletion(request, 1000);
                return null;
            }

            if (!completionText) {
                return null;
            }

            this.lastErrorMessage = null;
            return new Completion(completionText.text, request.completionPositionStart, completionText.toLineEnd);
        } catch (error: unknown) {
            this.inflightCompletion = null;
            if (this.isCancellationError(error, token)) {
                return null;
            }

            const message = this.formatRequestError(error);
            hasRequestError = true;
            this.statusBar.showError(message);
            log('Error from completion request: ' + message);
            log('Raw error: ' + this.stringifyError(error));

            if (this.lastErrorMessage !== message) {
                this.lastErrorMessage = message;
                await this.showRequestError(message, error);
            }

            return null;
        } finally {
            if (!hasRequestError) {
                this.statusBar.showIdle();
            }
        }
    }

    private isCancellationError(error: unknown, token: CancellationToken): boolean {
        return token.isCancellationRequested
            || error instanceof APIUserAbortError
            || (error instanceof Error && error.name === 'AbortError');
    }

    private async showRequestError(message: string, error: unknown): Promise<void> {
        if (error instanceof APIError && error.status === 401) {
            const selection = await window.showErrorMessage(message, setApiKeyAction);
            if (selection === setApiKeyAction) {
                await this.apiKeyStore.promptForApiKey();
            }
            return;
        }

        await window.showErrorMessage(message);
    }

    private formatRequestError(error: unknown): string {
        if (error instanceof APIConnectionTimeoutError) {
            return 'OpenAI request timed out. Check the server and try again.';
        }

        if (error instanceof APIConnectionError) {
            return 'OpenAI request failed to connect. Check `tabRocket.baseUrl` and that the server is running.';
        }

        if (error instanceof APIError) {
            if (error.status === 401) {
                return 'OpenAI request was rejected with 401 Unauthorized. Update the key with `TabRocket: Set API Key`.';
            }

            if (error.status === 429) {
                return 'OpenAI request was rate limited. Wait a moment and try again.';
            }

            return `OpenAI request failed with status ${error.status ?? 'unknown'}: ${error.message}`;
        }

        if (error instanceof Error) {
            return `OpenAI request failed: ${error.message}`;
        }

        return 'OpenAI request failed with an unknown error.';
    }

    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.stack ?? error.message;
        }

        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }

    private matchesForbiddenPattern(document: TextDocument): string | null {
        const relativePath = workspace.asRelativePath(document.uri, false);
        return getMatchingForbiddenPattern(relativePath, this.config.forbiddenFileNames);
    }

    public async provideInlineCompletionItems(
        document: TextDocument,
        position: Position,
        context: InlineCompletionContext,
        token: CancellationToken,
    ): Promise<InlineCompletionItem[] | InlineCompletionList | null> {
        if (document.uri.scheme === "vscode-scm") {
            return null;
        }

        const forbiddenPattern = this.matchesForbiddenPattern(document);
        if (forbiddenPattern !== null) {
            this.cancelActiveRequests();
            this.statusBar.showForbidden(`Completions disabled for files matching \`${forbiddenPattern}\`.`);
            return null;
        }

        this.statusBar.showIdle();

        if (!this.completionState.shouldProvideCompletions()) {
            return null;
        }

        const editor = window.activeTextEditor;
        if (!editor || editor.selections.length > 1) {
            return null;
        }

        if (this.activeCompletion !== null) {
            if (this.activeCompletion.stillValid(document, position)) {
                return [createInlineCompletionItem(document, this.activeCompletion, position)];
            }
            this.activeCompletion = null;
        }

        let request = this.getOrCreateRequest(document, position);

        this.activeCompletion = await this.resolveRequest(request, token);
        if (this.activeCompletion === null) {
            return null;
        }

        if (!this.activeCompletion.stillValid(document, position)) {
            request = this.newCompletionRequest(document, position);
            this.activeCompletion = await this.resolveRequest(request, token);
            if (this.activeCompletion === null) {
                return null;
            }
        }

        const completion = [createInlineCompletionItem(document, this.activeCompletion, position)];

        if (token.isCancellationRequested) {
            log('Providing completion NOT');
            return null;
        }
        log('Providing completion');
        return completion;
    }

    private shouldCancel(selection: Selection): boolean {
        if (selection.start.line !== selection.end.line || selection.start.character !== selection.end.character) {
            return true;
        }

        if (this.prevPosition !== null) {
            if (selection.active.line !== this.prevPosition.line) {
                return true;
            }

            if (selection.active.character < this.prevPosition.character) {
                return true;
            }
        }

        return false;
    }

    public cursorMoveEvent(e: TextEditorSelectionChangeEvent) {
        if (e.kind === undefined) {
            return;
        }

        if (e.kind === TextEditorSelectionChangeKind.Keyboard) {
            if (e.selections.length === 1 && !this.shouldCancel(e.selections[0])) {
                this.prevPosition = e.selections[0].active;
                return;
            }
        }

        this.prevPosition = e.selections[0].active;
        this.cancelActiveRequests();
    }

    private cancelActiveRequests() {
        this.activeCompletion = null;

        if (this.inflightCompletion) {
            this.inflightCompletion.cancel();
        }

        const pendingRequest = this.takePendingCompletion();
        if (pendingRequest !== null) {
            pendingRequest.cancel();
        }
    }

    public dispose() {
        this.stateListener.dispose();
        this.cancelActiveRequests();
    }
}
