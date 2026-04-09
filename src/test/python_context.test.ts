import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import {
    extractPythonImports,
    formatPythonContextBlock,
    resolvePythonImportTargets,
} from '../context/python_context';
import { fileContextRegistry } from '../context/file_context_registry';

suite('python context', () => {
    test('extracts Python imports from import and from-import statements', async () => {
        const imports = await extractPythonImports([
            'import foo',
            'import foo.bar as baz',
            'from .service import fetch_user',
            'from ..pkg.mod import thing as alias',
        ].join('\n'));

        assert.deepStrictEqual(imports, [
            { level: 0, modulePath: ['foo'], importedNames: null },
            { level: 0, modulePath: ['foo', 'bar'], importedNames: null },
            { level: 1, modulePath: ['service'], importedNames: [['fetch_user']] },
            { level: 2, modulePath: ['pkg', 'mod'], importedNames: [['thing']] },
        ]);
    });

    test('extracts public top-level symbols as valid Python stubs from file', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-python-symbols-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, [
                'class Foo:',
                '    VALUE = 1',
                '    title: str',
                '    age: int = 1',
                '    name = "foo"',
                '    _PRIVATE = 2',
                '',
                '    def __init__(self, title: str):',
                '        self.title = title',
                '',
                '    def run(self, x: int) -> int:',
                '        return x',
                '',
                '    async def load(self) -> str:',
                '        return None',
                '',
                '    @property',
                '    def title(self) -> str:',
                '        return "title"',
                '',
                '    def _internal(self):',
                '        return None',
                '',
                '    class Nested:',
                '        pass',
                '',
                'def bar(x: int, y = 1) -> int:',
                '    return x + y',
                '',
                'async def baz(value: str) -> str:',
                '    return value',
                '',
                '@decorator',
                'def qux() -> None:',
                '    return None',
                '',
                'VALUE = 1',
                '_PRIVATE = 2',
                '',
                'def outer() -> int:',
                '    def inner():',
                '        return 1',
                '    return inner()',
            ].join('\n'), 'utf8');

            const symbols = await fileContextRegistry.getSymbols(filePath);

            assert.deepStrictEqual(symbols, [
                [
                    'class Foo:',
                    '    VALUE = ...',
                    '    title: str = ...',
                    '    age: int = ...',
                    '    name = ...',
                    '    def __init__(self, title: str): ...',
                    '    def run(self, x: int) -> int: ...',
                    '    async def load(self) -> str: ...',
                    '    def title(self) -> str: ...',
                ].join('\n'),
                'def bar(x: int, y = 1) -> int: ...',
                'async def baz(value: str) -> str: ...',
                'def qux() -> None: ...',
                'VALUE = ...',
                'def outer() -> int: ...',
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('formats context blocks with a filename header', () => {
        assert.strictEqual(
            formatPythonContextBlock('pkg/service.py', ['class Foo: ...', 'def bar(): ...']),
            '# pkg/service.py\nclass Foo: ...\ndef bar(): ...',
        );
    });

    test('preserves multiline function headers in extracted stubs from file', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-python-multiline-'));
        try {
            const filePath = path.join(tempRoot, 'module.py');
            await writeFile(filePath, [
                'def build_user(',
                '    name: str,',
                '    age: int,',
                ') -> User:',
                '    return User(name, age)',
            ].join('\n'), 'utf8');

            const symbols = await fileContextRegistry.getSymbols(filePath);

            assert.deepStrictEqual(symbols, [
                [
                    'def build_user(',
                    '    name: str,',
                    '    age: int,',
                    ') -> User: ...',
                ].join('\n'),
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('resolves workspace-local absolute and relative imports', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-python-context-'));
        await writeFile(path.join(tempRoot, 'foo.py'), 'VALUE = 1\n', 'utf8');
        await mkdir(path.join(tempRoot, 'pkg'));
        await writeFile(path.join(tempRoot, 'pkg', 'service.py'), 'def fetch_user():\n    return None\n', 'utf8');

        const documentPath = path.join(tempRoot, 'pkg', 'main.py');
        const resolvedTargets = await resolvePythonImportTargets(documentPath, [tempRoot], [
            { level: 0, modulePath: ['foo'], importedNames: null },
            { level: 1, modulePath: ['service'], importedNames: [['fetch_user']] },
        ]);

        assert.deepStrictEqual(resolvedTargets, [
            { filePaths: [path.join(tempRoot, 'foo.py')] },
            { filePaths: [path.join(tempRoot, 'pkg', 'service.py')] },
        ]);
    });

    test('resolves from-relative imports without a module path via imported names', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-python-context-'));
        await mkdir(path.join(tempRoot, 'pkg'));
        await writeFile(path.join(tempRoot, 'pkg', 'helper.py'), 'def run():\n    return 1\n', 'utf8');

        const documentPath = path.join(tempRoot, 'pkg', 'main.py');
        const resolvedTargets = await resolvePythonImportTargets(documentPath, [tempRoot], [
            { level: 1, modulePath: [], importedNames: [['helper']] },
        ]);

        assert.deepStrictEqual(resolvedTargets, [
            { filePaths: [path.join(tempRoot, 'pkg', 'helper.py')] },
        ]);
    });
});
