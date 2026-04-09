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
            async resolveImportTargets() {
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
            100,
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
            async resolveImportTargets() {
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
            100,
            new AbortController().signal,
        );

        assert.strictEqual(importedContext, '');
        assert.strictEqual(hookCalls, 0);
    });

    test('collects imported context blocks while skipping empty and out-of-workspace targets', async () => {
        const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-workspace-'));
        const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-outside-'));

        try {
            const insideDirectory = path.join(workspaceRoot, 'pkg');
            await mkdir(insideDirectory, { recursive: true });

            const emptySymbolsPath = path.join(insideDirectory, 'empty.py');
            const validSymbolsPath = path.join(insideDirectory, 'service.py');
            const outsidePath = path.join(outsideRoot, 'outside.py');

            await writeFile(emptySymbolsPath, 'local_var = 1\n', 'utf8');
            await writeFile(validSymbolsPath, 'VALUE = 1\n', 'utf8');
            await writeFile(outsidePath, 'VALUE = 2\n', 'utf8');

            const blocks = await collectImportedContextBlocks({
                resolvedTargets: [
                    { filePaths: [emptySymbolsPath] },
                    { filePaths: [validSymbolsPath] },
                    { filePaths: [outsidePath] },
                ],
                workspaceRoots: [workspaceRoot],
                abort: new AbortController().signal,
                maxLength: 1000,
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

    test('aggregates symbols across multiple files in one target', async () => {
        const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-workspace-'));

        try {
            const firstFilePath = path.join(workspaceRoot, 'service.py');
            const secondFilePath = path.join(workspaceRoot, 'service_extra.py');
            await writeFile(firstFilePath, 'A = 1\nB = 2\n', 'utf8');
            await writeFile(secondFilePath, 'C = 3\n', 'utf8');

            const blocks = await collectImportedContextBlocks({
                resolvedTargets: [{
                    displayName: 'pkg/service',
                    filePaths: [firstFilePath, secondFilePath],
                }],
                workspaceRoots: [workspaceRoot],
                abort: new AbortController().signal,
                maxLength: 100,
                formatContextBlock(fileName: string, symbols: string[]): string {
                    return `# ${fileName}\n${symbols.join('\n')}`;
                },
            });

            assert.deepStrictEqual(blocks, ['# pkg/service\nA = ...\nB = ...\nC = ...']);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    test('limits imported context blocks by max length during collection', async () => {
        const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-provider-shared-workspace-'));

        try {
            const firstFilePath = path.join(workspaceRoot, 'service.py');
            const secondFilePath = path.join(workspaceRoot, 'service_extra.py');
            await writeFile(firstFilePath, 'A = 1\nB = 2\n', 'utf8');
            await writeFile(secondFilePath, 'C = 3\n', 'utf8');
            const expectedBlock = '# pkg/service\nA = ...\nB = ...';

            const blocks = await collectImportedContextBlocks({
                resolvedTargets: [{
                    displayName: 'pkg/service',
                    filePaths: [firstFilePath, secondFilePath],
                }],
                workspaceRoots: [workspaceRoot],
                abort: new AbortController().signal,
                maxLength: expectedBlock.length,
                formatContextBlock(fileName: string, symbols: string[]): string {
                    return `# ${fileName}\n${symbols.join('\n')}`;
                },
            });

            assert.deepStrictEqual(blocks, [expectedBlock]);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
