import OpenAI from 'openai';
import { Position, Range, TextDocument, workspace } from 'vscode';
import { TabRocketConfig } from './config';
import { buildPythonImportedContext } from './context/python_context';
import { log } from './logger';
import { getReservedPromptTokens, renderInfillPrompt } from './prompt_renderer';
import { performance } from 'perf_hooks';

export function formatPythonAugmentedPrefix(fileName: string, prefix: string, importedContext: string): string {
    const activeFileBlock = `# ${fileName}\n${prefix}`;
    if (importedContext.length === 0) {
        return activeFileBlock;
    }

    return `${importedContext}\n\n${activeFileBlock}`;
}

export class CompletionText {
    text: string;
    toLineEnd: boolean;

    constructor(text: string, toLineEnd: boolean) {
        this.text = text;
        this.toLineEnd = toLineEnd;
    }
}

export class CompletionRequest {
    client: OpenAI;
    config: TabRocketConfig;
    model: string;
    prefixContextMaxLength: number;
    suffixContextMaxLength: number;
    generationPromise: Promise<CompletionText | null>;
    abortController: AbortController;
    completionPositionStart: Position;
    generatedCompletion: CompletionText | null | undefined = undefined;

    constructor(
        client: OpenAI,
        config: TabRocketConfig,
        document: TextDocument,
        completionPositionStart: Position,
        waitUntil: number,
        reportRequestSent: () => void,
    ) {
        this.client = client;
        this.config = config;
        this.model = config.model;
        this.prefixContextMaxLength = config.prefixContextMaxLength;
        this.suffixContextMaxLength = config.suffixContextMaxLength;
        this.abortController = new AbortController();
        this.completionPositionStart = completionPositionStart;
        this.generationPromise = this.generateCompletion(document, this.abortController.signal, waitUntil, reportRequestSent);
    }

    async wait(): Promise<CompletionText | null> {
        if (this.generatedCompletion !== undefined) {
            return this.generatedCompletion;
        }
        this.generatedCompletion = await this.generationPromise;
        return this.generatedCompletion;
    }

    cancel() {
        this.abortController.abort();
        this.generatedCompletion = null;
    }

    private async generateCompletion(document: TextDocument, abort: AbortSignal, waitUntil: number, reportRequestSent: () => void): Promise<CompletionText | null> {
        const [prefix, suffix] = await this.getPrefixSuffix(document, this.completionPositionStart, abort);
        if (prefix === null || suffix === null) {
            return null;
        }

        if (!await this.sleep(waitUntil - performance.now(), abort)) {
            return null;
        }

        return await this.requestSingleLineCompletion(prefix, suffix, abort, reportRequestSent);
    }

    private async getPrefixSuffix(document: TextDocument, position: Position, abort: AbortSignal): Promise<[string | null, string | null]> {
        const fullPrefix = document.getText(new Range(0, 0, position.line, position.character));
        const fullSuffix = document.getText(new Range(
            position.line,
            position.character,
            document.lineCount - 1,
            document.lineAt(document.lineCount - 1).text.length,
        ));
        const prefix = this.limitPrefixContext(fullPrefix);
        const suffix = this.limitSuffixContext(fullSuffix);

        if (prefix.length === 0 && suffix.length === 0) {
            return [null, null];
        }

        return [await this.augmentPrefix(document, prefix, abort), suffix];
    }

    private async augmentPrefix(document: TextDocument, prefix: string, abort: AbortSignal): Promise<string> {
        if (document.languageId !== 'python' || document.uri.scheme !== 'file') {
            return prefix;
        }

        try {
            const importedContext = await buildPythonImportedContext(document, abort);
            const fileName = workspace.asRelativePath(document.uri, false);
            return formatPythonAugmentedPrefix(fileName, prefix, importedContext);
        } catch (error: unknown) {
            if (abort.aborted) {
                return prefix;
            }

            const message = error instanceof Error ? error.message : String(error);
            log('Failed to build Python imported context: ' + message);
            return prefix;
        }
    }

    private limitPrefixContext(prefix: string): string {
        if (this.prefixContextMaxLength === 0) {
            return '';
        }

        if (prefix.length <= this.prefixContextMaxLength) {
            return prefix;
        }

        return prefix.slice(-this.prefixContextMaxLength);
    }

    private limitSuffixContext(suffix: string): string {
        if (this.suffixContextMaxLength === 0) {
            return '';
        }

        if (suffix.length <= this.suffixContextMaxLength) {
            return suffix;
        }

        return suffix.slice(0, this.suffixContextMaxLength);
    }

    private async requestSingleLineCompletion(prefix: string, suffix: string, abort: AbortSignal, reportRequestSent: () => void): Promise<CompletionText | null> {
        log('Requesting completion: type: ' + this.config.promptTemplate + ', prefix:\n' + prefix + '\nSuffix:\n' + suffix);

        const prompt = renderInfillPrompt(this.config.promptTemplate, prefix, suffix);
        const stop = [...getReservedPromptTokens(this.config.promptTemplate)];

        reportRequestSent();
        const stream = await this.client.completions.create({
            model: this.model,
            prompt,
            max_tokens: 256,
            stop,
            stream: true,
        }, { signal: abort });

        let completion = '';
        let tolineEnd = false;
        for await (const chunk of stream) {
            if (abort.aborted) {
                log('Completion request aborted');
                return null;
            }

            if (!chunk.choices[0] || !chunk.choices[0].text) {
                continue;
            }
            completion += chunk.choices[0].text;

            const leadingWhitespaceLength = completion.length - completion.trimStart().length;
            const lineEnd = completion.indexOf('\n', leadingWhitespaceLength);
            if (lineEnd !== -1) {
                completion = completion.substring(0, lineEnd);
                tolineEnd = true;
                break;
            }
        }

        log('Received completion: "' + completion + '"' + (tolineEnd ? ' (to line end)' : ''));
        return new CompletionText(completion.trim().length === 0 ? '' : completion, tolineEnd);
    }

    private async sleep(ms: number, abort: AbortSignal): Promise<boolean> {
        if (ms <= 0) {
            return true;
        }
        if (abort.aborted) {
            return false;
        }
        return await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                abort.removeEventListener('abort', onAbort);
                resolve(true);
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                abort.removeEventListener('abort', onAbort);
                resolve(false);
            };
            abort.addEventListener('abort', onAbort, { once: true });
        });
    }
}
