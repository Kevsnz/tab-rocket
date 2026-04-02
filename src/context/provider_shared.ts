import { promises as fs } from 'fs';
import * as path from 'path';
import { TextDocument, Uri, workspace } from 'vscode';

export const defaultMaxImportedFiles = 10;
export const defaultMaxSymbolsPerFile = 20;
export const defaultMaxImportedFileSizeBytes = 64 * 1024;

export type PrefixAugmentationProvider<TImport> = {
    supports(document: TextDocument): boolean;
    collectImports(source: string, abort?: AbortSignal, document?: TextDocument): Promise<TImport[]>;
    resolveImportPaths(documentPath: string, workspaceRoots: string[], imports: TImport[]): Promise<string[]>;
    extractSymbols(source: string, abort?: AbortSignal, filePath?: string): Promise<string[]>;
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

export async function readWorkspaceContextFile(filePath: string, maxFileSizeBytes: number): Promise<string | null> {
    const openDocument = workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.fsPath === filePath);
    if (openDocument !== undefined) {
        return openDocument.getText();
    }

    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > maxFileSizeBytes) {
        return null;
    }

    return await fs.readFile(filePath, 'utf8');
}

export type ImportedContextCollectorOptions<TSymbol> = {
    resolvedPaths: string[];
    workspaceRoots: string[];
    abort: AbortSignal;
    maxFileSizeBytes: number;
    maxSymbolsPerFile: number;
    extractSymbols(source: string, abort?: AbortSignal, filePath?: string): Promise<TSymbol[]>;
    formatContextBlock(fileName: string, symbols: TSymbol[]): string;
};

export async function collectImportedContextBlocks<TSymbol>(
    options: ImportedContextCollectorOptions<TSymbol>,
): Promise<string[]> {
    const blocks: string[] = [];

    for (const resolvedPath of options.resolvedPaths) {
        if (options.abort.aborted || !isPathInsideWorkspace(resolvedPath, options.workspaceRoots)) {
            break;
        }

        const content = await readWorkspaceContextFile(resolvedPath, options.maxFileSizeBytes);
        if (content === null) {
            continue;
        }

        const symbols = (await options.extractSymbols(content, options.abort, resolvedPath)).slice(0, options.maxSymbolsPerFile);
        if (symbols.length === 0) {
            continue;
        }

        const fileName = workspace.asRelativePath(Uri.file(resolvedPath), false);
        blocks.push(options.formatContextBlock(fileName, symbols));
    }

    return blocks;
}

export async function buildImportedContext(
    provider: AnyPrefixAugmentationProvider,
    document: TextDocument,
    abort: AbortSignal,
): Promise<string> {
    if (!provider.supports(document)) {
        return '';
    }

    const workspaceRoots = workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (workspaceRoots.length === 0) {
        return '';
    }

    const imports = await provider.collectImports(document.getText(), abort, document);
    const resolvedPaths = await provider.resolveImportPaths(document.uri.fsPath, workspaceRoots, imports);
    const blocks = await collectImportedContextBlocks({
        resolvedPaths,
        workspaceRoots,
        abort,
        maxFileSizeBytes: defaultMaxImportedFileSizeBytes,
        maxSymbolsPerFile: defaultMaxSymbolsPerFile,
        extractSymbols: provider.extractSymbols,
        formatContextBlock: provider.formatContextBlock,
    });

    return blocks.join('\n\n');
}
