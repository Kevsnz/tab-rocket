import { TextDocument, workspace } from 'vscode';
import { getPrefixAugmentationProviders } from './provider_registry';
import { buildImportedContext } from './provider_shared';
import type { AnyPrefixAugmentationProvider } from './provider_shared';

export type { AnyPrefixAugmentationProvider, PrefixAugmentationProvider } from './provider_shared';

export function formatAugmentedPrefix(activeFileBlock: string, importedContext: string): string {
    if (importedContext.length === 0) {
        return activeFileBlock;
    }

    return `${importedContext}\n\n${activeFileBlock}`;
}

function limitPrefixTail(prefix: string, maxLength: number): string {
    if (maxLength <= 0) {
        return '';
    }

    if (prefix.length <= maxLength) {
        return prefix;
    }

    return prefix.slice(-maxLength);
}

function buildBoundedActiveFileBlock(
    provider: AnyPrefixAugmentationProvider,
    fileName: string,
    prefix: string,
    maxLength: number,
): string {
    if (maxLength <= 0) {
        return '';
    }

    const header = provider.formatActiveFileBlock(fileName, '');
    if (header.length >= maxLength) {
        return header.slice(0, maxLength);
    }

    const availablePrefixLength = maxLength - header.length;
    const limitedPrefix = limitPrefixTail(prefix, availablePrefixLength);
    return provider.formatActiveFileBlock(fileName, limitedPrefix);
}

export async function augmentDocumentPrefix(
    document: TextDocument,
    prefix: string,
    maxLength: number,
    abort: AbortSignal,
): Promise<string> {
    if (maxLength <= 0) {
        return '';
    }

    const providers = getPrefixAugmentationProviders();
    const provider = providers.find((candidate) => candidate.supports(document));
    if (provider === undefined) {
        return limitPrefixTail(prefix, maxLength);
    }

    const fileName = workspace.asRelativePath(document.uri, false);
    const activeFileBlock = buildBoundedActiveFileBlock(provider, fileName, prefix, maxLength);
    const importedContext = await buildImportedContext(
        provider,
        document,
        Math.max(0, maxLength - activeFileBlock.length - 2),
        abort,
    );
    return formatAugmentedPrefix(activeFileBlock, importedContext);
}
