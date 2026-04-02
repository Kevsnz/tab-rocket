import { TextDocument } from 'vscode';
import type { Node } from 'web-tree-sitter';
import {
    deduplicatePaths,
    defaultMaxImportedFiles,
    PrefixAugmentationProvider,
} from './provider_shared';
import { parseTsx, parseTypeScript } from './tree_sitter';
import { promises as fs } from 'fs';
import * as path from 'path';

const typescriptModuleExtensions = [
    '.ts',
    '.tsx',
    '.d.ts',
];

const typescriptIndexCandidates = [
    'index.ts',
    'index.tsx',
    'index.d.ts',
];

type TypeScriptConfig = {
    basePath: string;
    baseUrl: string | null;
    paths: Record<string, string[]>;
};

export type TypeScriptImport = {
    moduleSpecifier: string;
    importedNames: string[];
    defaultImport: string | null;
    namespaceImport: string | null;
    isTypeOnly: boolean;
};

type TypeScriptLanguageId = 'typescript' | 'typescriptreact';

function isTypeScriptReactFile(filePath: string): boolean {
    return filePath.endsWith('.tsx');
}

async function parseTypeScriptLikeSource(
    source: string,
    languageId: TypeScriptLanguageId,
    abort?: AbortSignal,
): Promise<import('web-tree-sitter').Tree> {
    return languageId === 'typescriptreact'
        ? await parseTsx(source, abort)
        : await parseTypeScript(source, abort);
}

async function parseTypeScriptLikeFile(
    source: string,
    filePath: string,
    abort?: AbortSignal,
): Promise<import('web-tree-sitter').Tree> {
    return await parseTypeScriptLikeSource(source, isTypeScriptReactFile(filePath) ? 'typescriptreact' : 'typescript', abort);
}

function stripQuotes(text: string): string {
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\'')))) {
        return text.slice(1, -1);
    }

    return text;
}

function getImportSpecifierName(node: Node): string | null {
    const nameNode = node.childForFieldName('name');
    if (nameNode === null) {
        return null;
    }

    return nameNode.text;
}

export async function extractTypeScriptImports(
    source: string,
    abort?: AbortSignal,
    document?: TextDocument,
): Promise<TypeScriptImport[]> {
    const languageId: TypeScriptLanguageId = document?.languageId === 'typescriptreact' ? 'typescriptreact' : 'typescript';
    const tree = await parseTypeScriptLikeSource(source, languageId, abort);

    try {
        const imports: TypeScriptImport[] = [];
        for (const child of tree.rootNode.namedChildren) {
            if (child.type !== 'import_statement') {
                continue;
            }

            const sourceNode = child.childForFieldName('source');
            if (sourceNode === null) {
                continue;
            }

            const importClause = child.namedChildren.find((namedChild) => namedChild.type === 'import_clause') ?? null;
            const importedNames: string[] = [];
            let defaultImport: string | null = null;
            let namespaceImport: string | null = null;

            if (importClause !== null) {
                for (const clauseChild of importClause.namedChildren) {
                    if (clauseChild.type === 'identifier') {
                        defaultImport = clauseChild.text;
                        continue;
                    }

                    if (clauseChild.type === 'namespace_import') {
                        namespaceImport = clauseChild.lastNamedChild?.text ?? null;
                        continue;
                    }

                    if (clauseChild.type === 'named_imports') {
                        for (const specifier of clauseChild.namedChildren) {
                            if (specifier.type !== 'import_specifier') {
                                continue;
                            }

                            const name = getImportSpecifierName(specifier);
                            if (name !== null) {
                                importedNames.push(name);
                            }
                        }
                    }
                }
            }

            imports.push({
                moduleSpecifier: stripQuotes(sourceNode.text),
                importedNames,
                defaultImport,
                namespaceImport,
                isTypeOnly: child.text.startsWith('import type '),
            });
        }

        return imports;
    } finally {
        tree.delete();
    }
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function resolveTypeScriptModuleCandidate(basePath: string): Promise<string | null> {
    for (const extension of typescriptModuleExtensions) {
        const moduleFilePath = basePath + extension;
        if (await pathExists(moduleFilePath)) {
            return moduleFilePath;
        }
    }

    for (const indexFileName of typescriptIndexCandidates) {
        const indexPath = path.join(basePath, indexFileName);
        if (await pathExists(indexPath)) {
            return indexPath;
        }
    }

    return null;
}

function stripJsonComments(text: string): string {
    let result = '';
    let inString = false;
    let stringQuote = '';
    let index = 0;

    while (index < text.length) {
        const char = text[index];
        const nextChar = text[index + 1];

        if (inString) {
            result += char;
            if (char === '\\') {
                result += nextChar ?? '';
                index += 2;
                continue;
            }

            if (char === stringQuote) {
                inString = false;
                stringQuote = '';
            }

            index += 1;
            continue;
        }

        if (char === '"' || char === '\'') {
            inString = true;
            stringQuote = char;
            result += char;
            index += 1;
            continue;
        }

        if (char === '/' && nextChar === '/') {
            index += 2;
            while (index < text.length && text[index] !== '\n') {
                index += 1;
            }
            continue;
        }

        if (char === '/' && nextChar === '*') {
            index += 2;
            while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                index += 1;
            }
            index += 2;
            continue;
        }

        result += char;
        index += 1;
    }

    return result;
}

function stripTrailingJsonCommas(text: string): string {
    return text.replace(/,\s*([}\]])/g, '$1');
}

async function readTypeScriptConfig(configPath: string): Promise<TypeScriptConfig | null> {
    try {
        const rawConfig = await fs.readFile(configPath, 'utf8');
        const parsedConfig = JSON.parse(stripTrailingJsonCommas(stripJsonComments(rawConfig))) as {
            compilerOptions?: {
                baseUrl?: unknown;
                paths?: unknown;
            };
        };

        const compilerOptions = parsedConfig.compilerOptions ?? {};
        const paths = typeof compilerOptions.paths === 'object' && compilerOptions.paths !== null
            ? Object.fromEntries(
                Object.entries(compilerOptions.paths)
                    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string')),
            )
            : {};

        return {
            basePath: path.dirname(configPath),
            baseUrl: typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : null,
            paths,
        };
    } catch {
        return null;
    }
}

async function findNearestTypeScriptConfig(documentPath: string, workspaceRoots: string[]): Promise<TypeScriptConfig | null> {
    let currentDirectory = path.dirname(documentPath);

    while (workspaceRoots.some((workspaceRoot) => currentDirectory === workspaceRoot || currentDirectory.startsWith(workspaceRoot + path.sep))) {
        const tsconfigPath = path.join(currentDirectory, 'tsconfig.json');
        if (await pathExists(tsconfigPath)) {
            return await readTypeScriptConfig(tsconfigPath);
        }

        const jsconfigPath = path.join(currentDirectory, 'jsconfig.json');
        if (await pathExists(jsconfigPath)) {
            return await readTypeScriptConfig(jsconfigPath);
        }

        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }

    return null;
}

function getPathAliasMatch(pattern: string, moduleSpecifier: string): string | null {
    const wildcardCount = (pattern.match(/\*/g) ?? []).length;
    if (wildcardCount > 1) {
        return null;
    }

    if (!pattern.includes('*')) {
        return pattern === moduleSpecifier ? '' : null;
    }

    const [prefix, suffix] = pattern.split('*');
    if (!moduleSpecifier.startsWith(prefix) || !moduleSpecifier.endsWith(suffix)) {
        return null;
    }

    return moduleSpecifier.slice(prefix.length, moduleSpecifier.length - suffix.length);
}

function applyPathAliasTarget(target: string, match: string): string | null {
    const wildcardCount = (target.match(/\*/g) ?? []).length;
    if (wildcardCount > 1) {
        return null;
    }

    if (!target.includes('*')) {
        return match.length === 0 ? target : null;
    }

    return target.replace('*', match);
}

function getTypeScriptAliasCandidates(moduleSpecifier: string, config: TypeScriptConfig): string[] {
    const baseDirectory = config.baseUrl === null ? config.basePath : path.resolve(config.basePath, config.baseUrl);
    const candidates: string[] = [];

    for (const [pattern, targets] of Object.entries(config.paths)) {
        const match = getPathAliasMatch(pattern, moduleSpecifier);
        if (match === null) {
            continue;
        }

        for (const target of targets) {
            const aliasedTarget = applyPathAliasTarget(target, match);
            if (aliasedTarget !== null) {
                candidates.push(path.resolve(baseDirectory, aliasedTarget));
            }
        }
    }

    if (config.baseUrl !== null) {
        candidates.push(path.resolve(baseDirectory, moduleSpecifier));
    }

    return candidates;
}

export async function resolveTypeScriptImportPaths(
    documentPath: string,
    workspaceRoots: string[],
    imports: TypeScriptImport[],
): Promise<string[]> {
    const candidates: string[] = [];
    const nearestConfig = await findNearestTypeScriptConfig(documentPath, workspaceRoots);

    for (const typescriptImport of imports) {
        if (typescriptImport.moduleSpecifier.length === 0) {
            continue;
        }

        if (typescriptImport.moduleSpecifier.startsWith('.')) {
            candidates.push(path.resolve(path.dirname(documentPath), typescriptImport.moduleSpecifier));
            continue;
        }

        if (nearestConfig !== null) {
            candidates.push(...getTypeScriptAliasCandidates(typescriptImport.moduleSpecifier, nearestConfig));
        }

        for (const workspaceRoot of workspaceRoots) {
            candidates.push(path.join(workspaceRoot, typescriptImport.moduleSpecifier));
        }
    }

    const resolvedPaths: string[] = [];
    for (const candidate of candidates) {
        const resolvedPath = await resolveTypeScriptModuleCandidate(candidate);
        if (resolvedPath !== null) {
            resolvedPaths.push(path.normalize(resolvedPath));
        }

        if (resolvedPaths.length >= defaultMaxImportedFiles) {
            break;
        }
    }

    return deduplicatePaths(resolvedPaths).slice(0, defaultMaxImportedFiles);
}

function isPublicTypeScriptMember(node: Node): boolean {
    const nodeText = node.text.trimStart();
    if (nodeText.startsWith('private ') || nodeText.startsWith('protected ')) {
        return false;
    }

    const name = node.childForFieldName('name')?.text;
    return name !== undefined && !name.startsWith('#');
}

function formatTypeScriptMethodSignature(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    if (name === undefined || !isPublicTypeScriptMember(node)) {
        return null;
    }

    const parameters = node.childForFieldName('parameters')?.text ?? '()';
    if (name === 'constructor') {
        return `constructor${parameters};`;
    }

    const returnType = node.childForFieldName('return_type')?.text ?? '';
    return `${name}${parameters}${returnType};`;
}

function formatTypeScriptFieldSignature(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    if (name === undefined || !isPublicTypeScriptMember(node)) {
        return null;
    }

    const typeAnnotation = node.childForFieldName('type')?.text;
    if (typeAnnotation !== undefined) {
        return `${name}${typeAnnotation};`;
    }

    return `${name} = ...;`;
}

function formatTypeScriptClassStub(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    if (name === undefined || body === null) {
        return null;
    }

    const members: string[] = [];
    for (const child of body.namedChildren) {
        if (child.type === 'method_definition') {
            const signature = formatTypeScriptMethodSignature(child);
            if (signature !== null) {
                members.push(signature);
            }
            continue;
        }

        if (child.type === 'public_field_definition') {
            const signature = formatTypeScriptFieldSignature(child);
            if (signature !== null) {
                members.push(signature);
            }
        }
    }

    if (members.length === 0) {
        return `export class ${name} {}`;
    }

    return `export class ${name} {\n${members.map((member) => `    ${member}`).join('\n')}\n}`;
}

function formatTypeScriptFunctionStub(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    if (name === undefined) {
        return null;
    }

    const parameters = node.childForFieldName('parameters')?.text ?? '()';
    const returnType = node.childForFieldName('return_type')?.text ?? '';
    return `export function ${name}${parameters}${returnType};`;
}

function formatTypeScriptInterfaceStub(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body')?.text;
    if (name === undefined || body === undefined) {
        return null;
    }

    return `export interface ${name} ${body}`;
}

function formatTypeScriptTypeAliasStub(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    const value = node.childForFieldName('value')?.text;
    if (name === undefined || value === undefined) {
        return null;
    }

    return `export type ${name} = ${value};`;
}

function formatTypeScriptEnumStub(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body')?.text;
    if (name === undefined || body === undefined) {
        return null;
    }

    return `export enum ${name} ${body}`;
}

function formatTypeScriptConstStubs(node: Node): string[] {
    if (!node.text.trimStart().startsWith('const ')) {
        return [];
    }

    const stubs: string[] = [];
    for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') {
            continue;
        }

        const name = declarator.childForFieldName('name')?.text;
        if (name === undefined) {
            continue;
        }

        const typeAnnotation = declarator.childForFieldName('type')?.text;
        if (typeAnnotation !== undefined) {
            stubs.push(`export const ${name}${typeAnnotation};`);
            continue;
        }

        stubs.push(`export const ${name} = ...;`);
    }

    return stubs;
}

export async function extractTypeScriptSymbols(source: string, abort?: AbortSignal, filePath = 'file.ts'): Promise<string[]> {
    const tree = await parseTypeScriptLikeFile(source, filePath, abort);

    try {
        const symbols: string[] = [];
        for (const child of tree.rootNode.namedChildren) {
            if (child.type !== 'export_statement') {
                continue;
            }

            const declaration = child.childForFieldName('declaration');
            if (declaration === null) {
                continue;
            }

            if (declaration.type === 'function_declaration') {
                const stub = formatTypeScriptFunctionStub(declaration);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (declaration.type === 'class_declaration') {
                const stub = formatTypeScriptClassStub(declaration);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (declaration.type === 'interface_declaration') {
                const stub = formatTypeScriptInterfaceStub(declaration);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (declaration.type === 'type_alias_declaration') {
                const stub = formatTypeScriptTypeAliasStub(declaration);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (declaration.type === 'enum_declaration') {
                const stub = formatTypeScriptEnumStub(declaration);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (declaration.type === 'lexical_declaration') {
                symbols.push(...formatTypeScriptConstStubs(declaration));
            }
        }

        return symbols;
    } finally {
        tree.delete();
    }
}

export function formatTypeScriptContextBlock(fileName: string, symbols: string[]): string {
    return `// ${fileName}\n${symbols.join('\n')}`;
}

export function formatTypeScriptActiveFileBlock(fileName: string, prefix: string): string {
    return `// ${fileName}\n${prefix}`;
}

export const typescriptPrefixAugmentationProvider: PrefixAugmentationProvider<TypeScriptImport> = {
    supports(document: TextDocument): boolean {
        return (document.languageId === 'typescript' || document.languageId === 'typescriptreact') && document.uri.scheme === 'file';
    },
    collectImports: extractTypeScriptImports,
    resolveImportPaths: resolveTypeScriptImportPaths,
    extractSymbols: extractTypeScriptSymbols,
    formatContextBlock: formatTypeScriptContextBlock,
    formatActiveFileBlock: formatTypeScriptActiveFileBlock,
};
