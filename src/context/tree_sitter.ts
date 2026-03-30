import * as fs from 'fs';
import * as path from 'path';
import TreeSitter = require('web-tree-sitter');

let runtimeInitialization: Promise<void> | null = null;
let pythonLanguageInitialization: Promise<TreeSitter.Language> | null = null;

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

function getPythonGrammarWasmPath(): string {
    return path.join(getBundledAssetsDirectory(), 'tree-sitter-python.wasm');
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

async function getPythonLanguage(): Promise<TreeSitter.Language> {
    if (pythonLanguageInitialization !== null) {
        return await pythonLanguageInitialization;
    }

    pythonLanguageInitialization = (async () => {
        await initializeRuntime();
        return await TreeSitter.Language.load(getPythonGrammarWasmPath());
    })();

    return await pythonLanguageInitialization;
}

export async function createPythonParser(): Promise<TreeSitter.Parser> {
    await initializeRuntime();
    const parser = new TreeSitter.Parser();
    parser.setLanguage(await getPythonLanguage());
    return parser;
}

export async function parsePython(source: string, abort?: AbortSignal): Promise<TreeSitter.Tree> {
    const parser = await createPythonParser();
    const tree = parser.parse(source, undefined, abort ? {
        progressCallback: () => abort.aborted,
    } : undefined);

    if (tree === null) {
        throw new Error(abort?.aborted ? 'Python parsing aborted.' : 'Python parsing failed.');
    }

    return tree;
}
