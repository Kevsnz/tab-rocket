import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { TextDocument, Uri } from 'vscode';
import {
    extractTypeScriptImports,
    extractTypeScriptSymbols,
    formatTypeScriptContextBlock,
    resolveTypeScriptImportPaths,
} from '../context/typescript_context';

suite('typescript context', () => {
    function createDocument(languageId: string, filePath: string, text: string): TextDocument {
        return {
            languageId,
            uri: Uri.file(filePath),
            getText(): string {
                return text;
            },
        } as TextDocument;
    }

    test('extracts TypeScript imports from supported import statements', async () => {
        const imports = await extractTypeScriptImports([
            'import foo from "./default";',
            'import * as ns from "./namespace";',
            'import { bar, baz as qux } from "./named";',
            'import type { User } from "pkg/models";',
        ].join('\n'));

        assert.deepStrictEqual(imports, [
            {
                moduleSpecifier: './default',
                importedNames: [],
                defaultImport: 'foo',
                namespaceImport: null,
                isTypeOnly: false,
            },
            {
                moduleSpecifier: './namespace',
                importedNames: [],
                defaultImport: null,
                namespaceImport: 'ns',
                isTypeOnly: false,
            },
            {
                moduleSpecifier: './named',
                importedNames: ['bar', 'baz'],
                defaultImport: null,
                namespaceImport: null,
                isTypeOnly: false,
            },
            {
                moduleSpecifier: 'pkg/models',
                importedNames: ['User'],
                defaultImport: null,
                namespaceImport: null,
                isTypeOnly: true,
            },
        ]);
    });

    test('extracts TSX imports with the TypeScript React grammar', async () => {
        const imports = await extractTypeScriptImports([
            'import { Card } from "./Card";',
            'export function App() {',
            '    return <Card title="hi" />;',
            '}',
        ].join('\n'), undefined, createDocument('typescriptreact', '/workspace/App.tsx', ''));

        assert.deepStrictEqual(imports, [
            {
                moduleSpecifier: './Card',
                importedNames: ['Card'],
                defaultImport: null,
                namespaceImport: null,
                isTypeOnly: false,
            },
        ]);
    });

    test('extracts exported TypeScript symbols as declaration-like stubs', async () => {
        const symbols = await extractTypeScriptSymbols([
            'export interface User { id: string }',
            'export type UserId = string',
            'export const DEFAULT_TIMEOUT: number = 30',
            'export function fetchUser(id: string): User { return {} as User }',
            'export class UserService {',
            '    private secret: string = "x"',
            '    timeout: number = 1',
            '    constructor(timeout: number) { this.timeout = timeout }',
            '    fetch(id: string): User { return {} as User }',
            '}',
            'export enum Status { Active, Disabled }',
            'const hidden = 1',
        ].join('\n'));

        assert.deepStrictEqual(symbols, [
            'export interface User { id: string }',
            'export type UserId = string;',
            'export const DEFAULT_TIMEOUT: number;',
            'export function fetchUser(id: string): User;',
            [
                'export class UserService {',
                '    timeout: number;',
                '    constructor(timeout: number);',
                '    fetch(id: string): User;',
                '}',
            ].join('\n'),
            'export enum Status { Active, Disabled }',
        ]);
    });

    test('extracts exported TSX symbols from imported tsx files', async () => {
        const symbols = await extractTypeScriptSymbols([
            'export interface CardProps { title: string }',
            'export function Card(props: CardProps) {',
            '    return <div>{props.title}</div>;',
            '}',
            'export const CARD_KIND: string = "primary"',
        ].join('\n'), undefined, 'Card.tsx');

        assert.deepStrictEqual(symbols, [
            'export interface CardProps { title: string }',
            'export function Card(props: CardProps);',
            'export const CARD_KIND: string;',
        ]);
    });

    test('formats TypeScript context blocks with a filename header', () => {
        assert.strictEqual(
            formatTypeScriptContextBlock('pkg/service.ts', ['export function run(): void;']),
            '// pkg/service.ts\nexport function run(): void;',
        );
    });

    test('resolves workspace-local relative and absolute TypeScript imports', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-typescript-context-'));
        try {
            await writeFile(path.join(tempRoot, 'shared.ts'), 'export const SHARED = 1\n', 'utf8');
            await mkdir(path.join(tempRoot, 'pkg', 'service'), { recursive: true });
            await writeFile(path.join(tempRoot, 'pkg', 'service', 'index.ts'), 'export const RUN = 1\n', 'utf8');

            const documentPath = path.join(tempRoot, 'pkg', 'main.ts');
            const resolvedPaths = await resolveTypeScriptImportPaths(documentPath, [tempRoot], [
                {
                    moduleSpecifier: '../shared',
                    importedNames: ['SHARED'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: false,
                },
                {
                    moduleSpecifier: 'pkg/service',
                    importedNames: ['RUN'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: false,
                },
            ]);

            assert.deepStrictEqual(resolvedPaths, [
                path.join(tempRoot, 'shared.ts'),
                path.join(tempRoot, 'pkg', 'service', 'index.ts'),
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('resolves TypeScript imports through baseUrl and paths aliases', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-typescript-context-'));
        try {
            await mkdir(path.join(tempRoot, 'src', 'lib'), { recursive: true });
            await mkdir(path.join(tempRoot, 'src', 'models'), { recursive: true });
            await writeFile(path.join(tempRoot, 'src', 'lib', 'math.ts'), 'export const add = () => 1\n', 'utf8');
            await writeFile(path.join(tempRoot, 'src', 'models', 'user.ts'), 'export interface User {}\n', 'utf8');
            await writeFile(path.join(tempRoot, 'tsconfig.json'), [
                '{',
                '  // test config',
                '  "compilerOptions": {',
                '    "baseUrl": "./src",',
                '    "paths": {',
                '      "@lib/*": ["lib/*"],',
                '      "@models/*": ["models/*"],',
                '    },',
                '  },',
                '}',
            ].join('\n'), 'utf8');

            const documentPath = path.join(tempRoot, 'src', 'main.ts');
            const resolvedPaths = await resolveTypeScriptImportPaths(documentPath, [tempRoot], [
                {
                    moduleSpecifier: '@lib/math',
                    importedNames: ['add'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: false,
                },
                {
                    moduleSpecifier: '@models/user',
                    importedNames: ['User'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: true,
                },
            ]);

            assert.deepStrictEqual(resolvedPaths, [
                path.join(tempRoot, 'src', 'lib', 'math.ts'),
                path.join(tempRoot, 'src', 'models', 'user.ts'),
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('resolves TypeScript imports through nearest jsconfig baseUrl', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-typescript-context-'));
        try {
            await mkdir(path.join(tempRoot, 'app', 'shared'), { recursive: true });
            await writeFile(path.join(tempRoot, 'app', 'shared', 'util.ts'), 'export const util = 1\n', 'utf8');
            await writeFile(path.join(tempRoot, 'app', 'jsconfig.json'), [
                '{',
                '  "compilerOptions": {',
                '    "baseUrl": "."',
                '  }',
                '}',
            ].join('\n'), 'utf8');

            const documentPath = path.join(tempRoot, 'app', 'feature', 'main.ts');
            const resolvedPaths = await resolveTypeScriptImportPaths(documentPath, [tempRoot], [
                {
                    moduleSpecifier: 'shared/util',
                    importedNames: ['util'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: false,
                },
            ]);

            assert.deepStrictEqual(resolvedPaths, [
                path.join(tempRoot, 'app', 'shared', 'util.ts'),
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('resolves cross-imports between ts and tsx files', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-typescript-context-'));
        try {
            await writeFile(path.join(tempRoot, 'Card.tsx'), 'export function Card() { return <div /> }\n', 'utf8');
            await writeFile(path.join(tempRoot, 'helpers.ts'), 'export function helper() { return 1 }\n', 'utf8');

            const tsResolvedPaths = await resolveTypeScriptImportPaths(path.join(tempRoot, 'main.ts'), [tempRoot], [
                {
                    moduleSpecifier: './Card',
                    importedNames: ['Card'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: false,
                },
            ]);
            const tsxResolvedPaths = await resolveTypeScriptImportPaths(path.join(tempRoot, 'App.tsx'), [tempRoot], [
                {
                    moduleSpecifier: './helpers',
                    importedNames: ['helper'],
                    defaultImport: null,
                    namespaceImport: null,
                    isTypeOnly: false,
                },
            ]);

            assert.deepStrictEqual(tsResolvedPaths, [path.join(tempRoot, 'Card.tsx')]);
            assert.deepStrictEqual(tsxResolvedPaths, [path.join(tempRoot, 'helpers.ts')]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
});
