import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { FileContextRegistry, LanguageFileParser } from '../context/file_context_registry';

suite('file context registry', () => {
    function createRegistry(): FileContextRegistry {
        return new (FileContextRegistry as any)();
    }

    function countingParser<TImport>(result: { imports: TImport[]; symbols: string[] }): LanguageFileParser<TImport> & { callCount: number } {
        const parser: LanguageFileParser<TImport> & { callCount: number } = {
            callCount: 0,
            async parse(): Promise<{ imports: TImport[]; symbols: string[] }> {
                parser.callCount += 1;
                return result;
            },
        };
        return parser;
    }

    test('parses file and returns imports and symbols from registered parser', async () => {
        const registry = createRegistry();
        const parser = countingParser({
            imports: [{ module: 'os' }],
            symbols: ['CONST = ...'],
        });
        registry.registerParser('python', parser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, 'dummy', 'utf8');

            const imports = await registry.getImports(filePath);
            const symbols = await registry.getSymbols(filePath);

            assert.deepStrictEqual(imports, [{ module: 'os' }]);
            assert.deepStrictEqual(symbols, ['CONST = ...']);
            assert.strictEqual(parser.callCount, 1, 'Parser should be called exactly once');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('returns empty arrays for unsupported file extensions', async () => {
        const registry = createRegistry();
        const parser = countingParser({ imports: ['imported'], symbols: ['SYM'] });
        registry.registerParser('python', parser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const filePath = path.join(tempRoot, 'module.rs');
            await writeFile(filePath, 'fn main() {}', 'utf8');

            const imports = await registry.getImports(filePath);
            const symbols = await registry.getSymbols(filePath);

            assert.deepStrictEqual(imports, []);
            assert.deepStrictEqual(symbols, []);
            assert.strictEqual(parser.callCount, 0, 'Parser should not be called for unsupported extension');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('returns empty arrays for non-existent files', async () => {
        const registry = createRegistry();
        const parser = countingParser({ imports: ['imported'], symbols: ['SYM'] });
        registry.registerParser('python', parser);

        const imports = await registry.getImports('/nonexistent/module.py');
        const symbols = await registry.getSymbols('/nonexistent/module.py');

        assert.deepStrictEqual(imports, []);
        assert.deepStrictEqual(symbols, []);
        assert.strictEqual(parser.callCount, 0, 'Parser should not be called for missing file');
    });

    test('returns cached result on second call without re-parsing', async () => {
        const registry = createRegistry();
        const parser = countingParser({
            imports: [{ module: 'os' }],
            symbols: ['CONST = ...'],
        });
        registry.registerParser('python', parser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, 'dummy', 'utf8');

            const symbols1 = await registry.getSymbols(filePath);
            const symbols2 = await registry.getSymbols(filePath);

            assert.deepStrictEqual(symbols1, symbols2);
            assert.strictEqual(parser.callCount, 1, 'Parser should only be called once due to caching');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('invalidates cache when file modification time changes', async () => {
        const registry = createRegistry();
        const parser = countingParser({
            imports: [],
            symbols: ['A = ...'],
        });
        registry.registerParser('python', parser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, 'A = 1', 'utf8');

            await registry.getSymbols(filePath);
            assert.strictEqual(parser.callCount, 1);

            await writeFile(filePath, 'B = 2', 'utf8');
            await registry.getSymbols(filePath);

            assert.strictEqual(parser.callCount, 2, 'Parser should be called again after file change');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('infers python from .py, go from .go, and typescript from .ts/.tsx/.d.ts', async () => {
        const registry = createRegistry();
        const pythonParser = countingParser({ imports: [], symbols: ['PYTHON_SYM'] });
        const goParser = countingParser({ imports: [], symbols: ['GO_SYM'] });
        const tsParser = countingParser({ imports: [], symbols: ['TS_SYM'] });
        registry.registerParser('python', pythonParser);
        registry.registerParser('go', goParser);
        registry.registerParser('typescript', tsParser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const pyPath = path.join(tempRoot, 'a.py');
            const goPath = path.join(tempRoot, 'main.go');
            const tsPath = path.join(tempRoot, 'b.ts');
            const tsxPath = path.join(tempRoot, 'c.tsx');
            const dtsPath = path.join(tempRoot, 'd.d.ts');

            await writeFile(pyPath, 'X = 1', 'utf8');
            await writeFile(goPath, 'package main', 'utf8');
            await writeFile(tsPath, 'export const X = 1', 'utf8');
            await writeFile(tsxPath, 'export const X = 1', 'utf8');
            await writeFile(dtsPath, 'export const X: number', 'utf8');

            const pySymbols = await registry.getSymbols(pyPath);
            const goSymbols = await registry.getSymbols(goPath);
            const tsSymbols = await registry.getSymbols(tsPath);
            const tsxSymbols = await registry.getSymbols(tsxPath);
            const dtsSymbols = await registry.getSymbols(dtsPath);

            assert.deepStrictEqual(pySymbols, ['PYTHON_SYM']);
            assert.deepStrictEqual(goSymbols, ['GO_SYM']);
            assert.deepStrictEqual(tsSymbols, ['TS_SYM']);
            assert.deepStrictEqual(tsxSymbols, ['TS_SYM']);
            assert.deepStrictEqual(dtsSymbols, ['TS_SYM']);
            assert.strictEqual(pythonParser.callCount, 1, 'Python parser called once for .py');
            assert.strictEqual(goParser.callCount, 1, 'Go parser called once for .go');
            assert.strictEqual(tsParser.callCount, 3, 'TypeScript parser called three times for .ts/.tsx/.d.ts');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('parses imports and symbols together in one parse call', async () => {
        const registry = createRegistry();
        const parser = countingParser({
            imports: [{ module: 'os' }],
            symbols: ['CONST = ...'],
        });
        registry.registerParser('python', parser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, 'dummy', 'utf8');

            const imports = await registry.getImports(filePath);
            const symbols = await registry.getSymbols(filePath);

            assert.deepStrictEqual(imports, [{ module: 'os' }]);
            assert.deepStrictEqual(symbols, ['CONST = ...']);
            assert.strictEqual(parser.callCount, 1, 'Single parse call should produce both imports and symbols');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('uses registered parser for matching language', async () => {
        const registry = createRegistry();
        const parser = countingParser<{ name: string }>({
            imports: [{ name: 'custom-import' }],
            symbols: ['custom-symbol'],
        });
        registry.registerParser('python', parser);

        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-registry-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, 'dummy', 'utf8');

            const imports = await registry.getImports(filePath);
            const symbols = await registry.getSymbols(filePath);

            assert.deepStrictEqual(imports, [{ name: 'custom-import' }]);
            assert.deepStrictEqual(symbols, ['custom-symbol']);
            assert.strictEqual(parser.callCount, 1, 'Registered parser should be called');
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
});
