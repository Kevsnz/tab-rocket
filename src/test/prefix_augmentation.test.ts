import * as assert from 'assert';
import { TextDocument, Uri } from 'vscode';
import { augmentDocumentPrefix, formatAugmentedPrefix } from '../context/prefix_augmentation';
import { getPrefixAugmentationProviders } from '../context/provider_registry';
import { formatPythonActiveFileBlock } from '../context/python_context';

suite('prefix augmentation', () => {
    function createDocument(languageId: string, filePath: string): TextDocument {
        return {
            languageId,
            uri: Uri.file(filePath),
        } as TextDocument;
    }

    test('formats augmented prefix with imported context blocks', () => {
        assert.strictEqual(
            formatAugmentedPrefix(
                formatPythonActiveFileBlock('pkg/main.py', 'from .service import fetch_user\n\nfetch_'),
                '# pkg/service.py\ndef fetch_user(user_id: str): ...',
            ),
            '# pkg/service.py\ndef fetch_user(user_id: str): ...\n\n# pkg/main.py\nfrom .service import fetch_user\n\nfetch_',
        );
    });

    test('formats augmented prefix without imported context', () => {
        assert.strictEqual(
            formatAugmentedPrefix(formatPythonActiveFileBlock('main.py', 'print(value)'), ''),
            '# main.py\nprint(value)',
        );
    });

    test('returns original prefix when no provider supports the document', async () => {
        const prefix = await augmentDocumentPrefix(
            createDocument('javascript', '/workspace/main.js'),
            'const value = 1;',
            new AbortController().signal,
        );

        assert.strictEqual(prefix, 'const value = 1;');
    });

    test('registers Python and TypeScript prefix augmentation providers', () => {
        const providers = getPrefixAugmentationProviders();

        assert.ok(providers.some((provider) => provider.supports(createDocument('python', '/workspace/main.py'))));
        assert.ok(providers.some((provider) => provider.supports(createDocument('typescript', '/workspace/main.ts'))));
        assert.ok(providers.some((provider) => provider.supports(createDocument('typescriptreact', '/workspace/App.tsx'))));
        assert.ok(!providers.some((provider) => provider.supports(createDocument('javascript', '/workspace/main.js'))));
    });
});
