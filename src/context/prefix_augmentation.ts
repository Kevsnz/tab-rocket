import { TextDocument, workspace } from 'vscode';
import { getPrefixAugmentationProviders } from './provider_registry';
import { buildImportedContext } from './provider_shared';

export type { AnyPrefixAugmentationProvider, PrefixAugmentationProvider } from './provider_shared';

export function formatAugmentedPrefix(activeFileBlock: string, importedContext: string): string {
    if (importedContext.length === 0) {
        return activeFileBlock;
    }

    return `${importedContext}\n\n${activeFileBlock}`;
}

export async function augmentDocumentPrefix(
    document: TextDocument,
    prefix: string,
    abort: AbortSignal,
): Promise<string> {
    const providers = getPrefixAugmentationProviders();
    const provider = providers.find((candidate) => candidate.supports(document));
    if (provider === undefined) {
        return prefix;
    }

    const importedContext = await buildImportedContext(provider, document, abort);
    const fileName = workspace.asRelativePath(document.uri, false);
    const activeFileBlock = provider.formatActiveFileBlock(fileName, prefix);
    return formatAugmentedPrefix(activeFileBlock, importedContext);
}
