import * as vscode from 'vscode';
import { log } from './logger';

const apiKeySecretKey = 'tabRocket.apiKey';

export class TabRocketApiKeyStore {
    private readonly secretStorage: vscode.SecretStorage;

    constructor(secretStorage: vscode.SecretStorage) {
        this.secretStorage = secretStorage;
    }

    async get(): Promise<string> {
        return await this.secretStorage.get(apiKeySecretKey) ?? '';
    }

    async clear(): Promise<void> {
        await this.secretStorage.delete(apiKeySecretKey);
    }

    onDidChange(listener: () => void): vscode.Disposable {
        return this.secretStorage.onDidChange((event) => {
            if (event.key === apiKeySecretKey) {
                listener();
            }
        });
    }

    async promptForApiKey() {
        const apiKey = await vscode.window.showInputBox({
            title: 'TabRocket API Key',
            prompt: 'Enter the API key used for completion requests.',
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'sk-...',
        });

        if (apiKey === undefined) {
            return;
        }

        const trimmedApiKey = apiKey.trim();
        if (trimmedApiKey.length === 0) {
            await this.secretStorage.delete(apiKeySecretKey);
            log('API key cleared');
            void vscode.window.showInformationMessage('TabRocket API key cleared.');
            return;
        }

        await this.secretStorage.store(apiKeySecretKey, trimmedApiKey);
        log('API key changed');
        void vscode.window.showInformationMessage('TabRocket API key set.');
    }
}
