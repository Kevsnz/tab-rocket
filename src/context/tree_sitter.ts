import * as fs from 'fs';
import * as path from 'path';
import TreeSitter = require('web-tree-sitter');

type SupportedLanguage = 'go' | 'python' | 'typescript' | 'tsx';

let runtimeInitialization: Promise<void> | null = null;
const languageInitializations = new Map<SupportedLanguage, Promise<TreeSitter.Language>>();

function getBundledAssetsDirectory(): string {
    const currentDirectoryAssets = path.join(__dirname, 'tree-sitter');
    if (fs.existsSync(currentDirectoryAssets)) {
        return currentDirectoryAssets;
    }

    return path.join(__dirname, '..', 'tree-sitter');
}

function getRuntimeWasmPath(): string {
    return path.join(getBundledAssetsDirectory(), 'web-tree-sitter.wasm');
}

function getGrammarWasmPath(language: SupportedLanguage): string {
    const fileName = language === 'go'
        ? 'tree-sitter-go.wasm'
        : language === 'python'
            ? 'tree-sitter-python.wasm'
            : language === 'typescript'
                ? 'tree-sitter-typescript.wasm'
                : 'tree-sitter-tsx.wasm';
    return path.join(getBundledAssetsDirectory(), fileName);
}

async function initializeRuntime(): Promise<void> {
    if (runtimeInitialization !== null) {
        return await runtimeInitialization;
    }

    const runtimeWasmPath = getRuntimeWasmPath();
    runtimeInitialization = TreeSitter.Parser.init({
        locateFile(fileName: string): string {
            if (fileName === 'web-tree-sitter.wasm') {
                return runtimeWasmPath;
            }

            return path.join(path.dirname(runtimeWasmPath), fileName);
        },
    });

    return await runtimeInitialization;
}

async function getLanguage(language: SupportedLanguage): Promise<TreeSitter.Language> {
    const existingInitialization = languageInitializations.get(language);
    if (existingInitialization !== undefined) {
        return await existingInitialization;
    }

    const initialization = (async () => {
        await initializeRuntime();
        return await TreeSitter.Language.load(getGrammarWasmPath(language));
    })();
    languageInitializations.set(language, initialization);

    return await initialization;
}

async function createParser(language: SupportedLanguage): Promise<TreeSitter.Parser> {
    await initializeRuntime();
    const parser = new TreeSitter.Parser();
    parser.setLanguage(await getLanguage(language));
    return parser;
}

async function parseSource(language: SupportedLanguage, source: string, abort?: AbortSignal): Promise<TreeSitter.Tree> {
    const parser = await createParser(language);
    const tree = parser.parse(source, undefined, abort ? {
        progressCallback: () => abort.aborted,
    } : undefined);

    if (tree === null) {
        throw new Error(abort?.aborted ? `${language} parsing aborted.` : `${language} parsing failed.`);
    }

    return tree;
}

export async function createGoParser(): Promise<TreeSitter.Parser> {
    return await createParser('go');
}

export async function createPythonParser(): Promise<TreeSitter.Parser> {
    return await createParser('python');
}

export async function createTypeScriptParser(): Promise<TreeSitter.Parser> {
    return await createParser('typescript');
}

export async function createTsxParser(): Promise<TreeSitter.Parser> {
    return await createParser('tsx');
}

export async function parseGo(source: string, abort?: AbortSignal): Promise<TreeSitter.Tree> {
    return await parseSource('go', source, abort);
}

export async function parsePython(source: string, abort?: AbortSignal): Promise<TreeSitter.Tree> {
    return await parseSource('python', source, abort);
}

export async function parseTypeScript(source: string, abort?: AbortSignal): Promise<TreeSitter.Tree> {
    return await parseSource('typescript', source, abort);
}

export async function parseTsx(source: string, abort?: AbortSignal): Promise<TreeSitter.Tree> {
    return await parseSource('tsx', source, abort);
}
