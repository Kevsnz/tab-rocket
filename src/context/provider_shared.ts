import { promises as fs } from 'fs';
import * as path from 'path';
import { TextDocument, Uri, workspace } from 'vscode';
import { fileContextRegistry } from './file_context_registry';

export const defaultMaxImportedFiles = 10;
export const defaultMaxImportedFileSizeBytes = 64 * 1024;

export type ImportedContextTarget = {
    filePaths: string[];
    displayName?: string;
};

export type PrefixAugmentationProvider<TImport> = {
    supports(document: TextDocument): boolean;
    collectImports(source: string, abort?: AbortSignal, document?: TextDocument): Promise<TImport[]>;
    resolveImportTargets(documentPath: string, workspaceRoots: string[], imports: TImport[]): Promise<ImportedContextTarget[]>;
    formatContextBlock(fileName: string, symbols: string[]): string;
    formatActiveFileBlock(fileName: string, prefix: string): string;
};

export type AnyPrefixAugmentationProvider = PrefixAugmentationProvider<unknown>;

export function deduplicatePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

export function isPathInsideWorkspace(filePath: string, workspaceRoots: string[]): boolean {
    const normalizedFilePath = path.resolve(filePath);
    return workspaceRoots.some((workspaceRoot) => {
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
        const relativePath = path.relative(normalizedWorkspaceRoot, normalizedFilePath);
        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    });
}

export type ImportedContextCollectorOptions = {
    resolvedTargets: ImportedContextTarget[];
    workspaceRoots: string[];
    abort: AbortSignal;
    maxLength: number;
    formatContextBlock(fileName: string, symbols: string[]): string;
};

function getTargetDisplayName(target: ImportedContextTarget): string {
    if (target.displayName !== undefined && target.displayName.length > 0) {
        return target.displayName;
    }

    const firstFilePath = target.filePaths[0];
    if (firstFilePath === undefined) {
        return '';
    }

    return workspace.asRelativePath(Uri.file(firstFilePath), false);
}

export async function collectImportedContextBlocks(
    options: ImportedContextCollectorOptions,
): Promise<string[]> {
    const blocks: string[] = [];
    let totalLength = 0;

    for (const resolvedTarget of options.resolvedTargets) {
        if (options.abort.aborted || totalLength >= options.maxLength) {
            break;
        }

        const displayName = getTargetDisplayName(resolvedTarget);
        const symbols: string[] = [];
        let block = '';
        let targetBudgetReached = false;
        for (const resolvedPath of deduplicatePaths(resolvedTarget.filePaths)) {
            if (options.abort.aborted || targetBudgetReached) {
                break;
            }

            if (!isPathInsideWorkspace(resolvedPath, options.workspaceRoots)) {
                continue;
            }

            const stats = await fs.stat(resolvedPath).catch(() => null);
            if (stats === null || !stats.isFile() || stats.size > defaultMaxImportedFileSizeBytes) {
                continue;
            }

            const fileSymbols = await fileContextRegistry.getSymbols(resolvedPath, options.abort);
            for (const symbol of fileSymbols) {
                symbols.push(symbol);
                const candidateBlock = options.formatContextBlock(displayName, symbols);
                const separatorLength = blocks.length === 0 ? 0 : 2;
                if (totalLength + separatorLength + candidateBlock.length > options.maxLength) {
                    symbols.pop();
                    targetBudgetReached = true;
                    break;
                }

                block = candidateBlock;
            }
        }

        if (block.length === 0) {
            continue;
        }

        const separatorLength = blocks.length === 0 ? 0 : 2;
        blocks.push(block);
        totalLength += separatorLength + block.length;
    }

    return blocks;
}

export async function buildImportedContext(
    provider: AnyPrefixAugmentationProvider,
    document: TextDocument,
    maxLength: number,
    abort: AbortSignal,
): Promise<string> {
    if (!provider.supports(document) || maxLength <= 0) {
        return '';
    }

    const workspaceRoots = workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (workspaceRoots.length === 0) {
        return '';
    }

    const imports = await provider.collectImports(document.getText(), abort, document);
    const resolvedTargets = await provider.resolveImportTargets(document.uri.fsPath, workspaceRoots, imports);
    const blocks = await collectImportedContextBlocks({
        resolvedTargets,
        workspaceRoots,
        abort,
        maxLength,
        formatContextBlock: provider.formatContextBlock,
    });

    return blocks.join('\n\n');
}
