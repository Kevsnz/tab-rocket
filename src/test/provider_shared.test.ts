import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { TextDocument, Uri, workspace } from 'vscode';
import {
    buildImportedContext,
    collectImportedContextBlocks,
    PrefixAugmentationProvider,
} from '../context/provider_shared';

suite('provider shared', () => {
    function createDocument(languageId: string, filePath: string, text: string): TextDocument {
        return {
            languageId,
            uri: Uri.file(filePath),
            getText(): string {
                return text;
            },
        } as TextDocument;
    }

    test('returns empty imported context when no workspace folders are open', async () => {
        assert.strictEqual(workspace.workspaceFolders, undefined);

        let hookCalls = 0;
        const provider: PrefixAugmentationProvider<{ module: string }> = {
            supports(): boolean {
                hookCalls += 1;
                return true;
            },
            async collectImports(): Promise<{ module: string }[]> {
                hookCalls += 1;
                return [{ module: 'service' }];
            },
            async resolveImportPaths(): Promise<string[]> {
                hookCalls += 1;
                return [];
            },
            async extractSymbols(): Promise<string[]> {
                hookCalls += 1;
                return [];
            },
            formatContextBlock(): string {
                hookCalls += 1;
                return '';
            },
            formatActiveFileBlock(): string {
                hookCalls += 1;
                return '';
            },
        };

        const importedContext = await buildImportedContext(
            provider,
            createDocument('python', '/workspace/main.py', 'from service import helper'),
            new AbortController().signal,
        );

        assert.strictEqual(importedContext, '');
        assert.strictEqual(hookCalls, 1);
    });

    test('returns empty imported context when provider does not support document', async () => {
        let hookCalls = 0;
        const provider: PrefixAugmentationProvider<{ module: string }> = {
            supports(): boolean {
                return false;
            },
            async collectImports(): Promise<{ module: string }[]> {
                hookCalls += 1;
                return [];
            },
            async resolveImportPaths(): Promise<string[]> {
                hookCalls += 1;
                return [];
            },
            async extractSymbols(): Promise<string[]> {
                hookCalls += 1;
                return [];
            },
            formatContextBlock(): string {
                hookCalls += 1;
                return '';
            },
            formatActiveFileBlock(): string {
                hookCalls += 1;
                return '';
            },
        };

        const importedContext = await buildImportedContext(
            provider,
            createDocument('typescript', '/workspace/main.ts', 'const value = 1;'),
            new AbortController().signal,
        );

        assert.strictEqual(importedContext, '');
        assert.strictEqual(hookCalls, 0);
    });

    test('collects imported context blocks while skipping empty and out-of-workspace files', async () => {
        const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-workspace-'));
        const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-outside-'));

        try {
            const insideDirectory = path.join(workspaceRoot, 'pkg');
            await mkdir(insideDirectory, { recursive: true });

            const emptySymbolsPath = path.join(insideDirectory, 'empty.py');
            const validSymbolsPath = path.join(insideDirectory, 'service.py');
            const outsidePath = path.join(outsideRoot, 'outside.py');

            await writeFile(emptySymbolsPath, 'NO_SYMBOLS\n', 'utf8');
            await writeFile(validSymbolsPath, 'VALUE = 1\n', 'utf8');
            await writeFile(outsidePath, 'VALUE = 2\n', 'utf8');

            const blocks = await collectImportedContextBlocks({
                resolvedPaths: [emptySymbolsPath, validSymbolsPath, outsidePath],
                workspaceRoots: [workspaceRoot],
                abort: new AbortController().signal,
                maxFileSizeBytes: 1024,
                maxSymbolsPerFile: 10,
                async extractSymbols(source: string): Promise<string[]> {
                    if (source.includes('NO_SYMBOLS')) {
                        return [];
                    }

                    return ['VALUE = ...'];
                },
                formatContextBlock(fileName: string, symbols: string[]): string {
                    return `# ${fileName}\n${symbols.join('\n')}`;
                },
            });

            assert.deepStrictEqual(blocks, [`# ${validSymbolsPath}\nVALUE = ...`]);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
            await rm(outsideRoot, { recursive: true, force: true });
        }
    });

    test('limits symbols per imported file during block collection', async () => {
        const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-workspace-'));

        try {
            const importedFilePath = path.join(workspaceRoot, 'service.py');
            await writeFile(importedFilePath, 'symbols\n', 'utf8');

            const blocks = await collectImportedContextBlocks({
                resolvedPaths: [importedFilePath],
                workspaceRoots: [workspaceRoot],
                abort: new AbortController().signal,
                maxFileSizeBytes: 1024,
                maxSymbolsPerFile: 2,
                async extractSymbols(): Promise<string[]> {
                    return ['A = ...', 'B = ...', 'C = ...'];
                },
                formatContextBlock(fileName: string, symbols: string[]): string {
                    return `# ${fileName}\n${symbols.join('\n')}`;
                },
            });

            assert.deepStrictEqual(blocks, [`# ${importedFilePath}\nA = ...\nB = ...`]);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
