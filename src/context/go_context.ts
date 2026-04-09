import { promises as fs } from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode';
import type { Node } from 'web-tree-sitter';
import {
    defaultMaxImportedFiles,
    ImportedContextTarget,
    PrefixAugmentationProvider,
} from './provider_shared';
import { fileContextRegistry, LanguageFileParser } from './file_context_registry';
import { parseGo } from './tree_sitter';

const exportedIdentifierPattern = /^\p{Lu}/u;

type GoModule = {
    modulePath: string;
    rootPath: string;
};

export type GoImport = {
    importPath: string;
    alias: string | null;
    isBlank: boolean;
    isDot: boolean;
};

function isExportedIdentifier(name: string): boolean {
    return exportedIdentifierPattern.test(name);
}

function stripGoStringLiteral(text: string): string {
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('`') && text.endsWith('`')))) {
        return text.slice(1, -1);
    }

    return text;
}

function getNamedChildrenByType(node: Node, type: string): Node[] {
    return node.namedChildren.filter((child) => child.type === type);
}

function getTypeParameters(node: Node): string {
    return node.childForFieldName('type_parameters')?.text ?? '';
}

function getResultSuffix(node: Node): string {
    const result = node.childForFieldName('result')?.text;
    return result === undefined ? '' : ` ${result}`;
}

function getFieldNames(node: Node): string[] {
    return node.childrenForFieldName('name').map((nameNode) => nameNode.text);
}

function getEmbeddedFieldExportName(typeText: string): string {
    let candidate = typeText.trim();
    while (candidate.startsWith('*')) {
        candidate = candidate.slice(1).trim();
    }

    const unqualified = candidate.split('.').pop() ?? candidate;
    return unqualified.split('[')[0] ?? unqualified;
}

function getEmbeddedFieldText(fieldNode: Node): string {
    const tagNode = fieldNode.childForFieldName('tag');
    if (tagNode === null) {
        return fieldNode.text;
    }

    const tagIndex = fieldNode.text.lastIndexOf(tagNode.text);
    if (tagIndex === -1) {
        return fieldNode.text;
    }

    return fieldNode.text.slice(0, tagIndex).trimEnd();
}

function formatStructFields(typeNode: Node): string[] {
    const fields: string[] = [];
    const fieldList = typeNode.namedChildren.find((child) => child.type === 'field_declaration_list') ?? null;
    if (fieldList === null) {
        return fields;
    }

    for (const fieldNode of getNamedChildrenByType(fieldList, 'field_declaration')) {
        const typeText = fieldNode.childForFieldName('type')?.text;
        if (typeText === undefined) {
            continue;
        }

        const names = getFieldNames(fieldNode);
        if (names.length === 0) {
            const embeddedFieldText = getEmbeddedFieldText(fieldNode);
            if (isExportedIdentifier(getEmbeddedFieldExportName(embeddedFieldText))) {
                fields.push(embeddedFieldText);
            }
            continue;
        }

        for (const name of names) {
            if (isExportedIdentifier(name)) {
                fields.push(`${name} ${typeText}`);
            }
        }
    }

    return fields;
}

function formatInterfaceElements(typeNode: Node): string[] {
    const elements: string[] = [];
    for (const child of typeNode.namedChildren) {
        if (child.type === 'method_elem') {
            const name = child.childForFieldName('name')?.text;
            if (name === undefined || !isExportedIdentifier(name)) {
                continue;
            }

            const parameters = child.childForFieldName('parameters')?.text ?? '()';
            elements.push(`${name}${parameters}${getResultSuffix(child)}`);
            continue;
        }

        if (child.type === 'type_elem') {
            elements.push(child.text);
        }
    }

    return elements;
}

function formatGoTypeStub(typeNode: Node): string | null {
    const name = typeNode.childForFieldName('name')?.text;
    if (name === undefined || !isExportedIdentifier(name)) {
        return null;
    }

    const typeText = typeNode.childForFieldName('type')?.text;
    if (typeText === undefined) {
        return null;
    }

    const typeParameters = getTypeParameters(typeNode);
    if (typeNode.type === 'type_alias') {
        return `type ${name}${typeParameters} = ${typeText}`;
    }

    const concreteTypeNode = typeNode.childForFieldName('type');
    if (concreteTypeNode?.type === 'struct_type') {
        const fields = formatStructFields(concreteTypeNode);
        if (fields.length === 0) {
            return `type ${name}${typeParameters} struct {}`;
        }

        return [
            `type ${name}${typeParameters} struct {`,
            ...fields.map((field) => `    ${field}`),
            '}',
        ].join('\n');
    }

    if (concreteTypeNode?.type === 'interface_type') {
        const elements = formatInterfaceElements(concreteTypeNode);
        if (elements.length === 0) {
            return `type ${name}${typeParameters} interface {}`;
        }

        return [
            `type ${name}${typeParameters} interface {`,
            ...elements.map((element) => `    ${element}`),
            '}',
        ].join('\n');
    }

    return `type ${name}${typeParameters} ${typeText}`;
}

function formatGoFunctionStub(node: Node): string | null {
    const name = node.childForFieldName('name')?.text;
    if (name === undefined || !isExportedIdentifier(name)) {
        return null;
    }

    const parameters = node.childForFieldName('parameters')?.text ?? '()';
    return `func ${name}${getTypeParameters(node)}${parameters}${getResultSuffix(node)}`;
}

function formatGoMethodStub(node: Node): string | null {
    const receiver = node.childForFieldName('receiver')?.text;
    const name = node.childForFieldName('name')?.text;
    if (receiver === undefined || name === undefined || !isExportedIdentifier(name)) {
        return null;
    }

    const parameters = node.childForFieldName('parameters')?.text ?? '()';
    return `func ${receiver} ${name}${parameters}${getResultSuffix(node)}`;
}

function formatGoValueSpec(specNode: Node, keyword: 'const' | 'var'): string[] {
    const typeText = specNode.childForFieldName('type')?.text;
    const stubs: string[] = [];

    for (const name of getFieldNames(specNode)) {
        if (!isExportedIdentifier(name)) {
            continue;
        }

        if (typeText !== undefined) {
            stubs.push(keyword === 'const' ? `const ${name} ${typeText} = ...` : `var ${name} ${typeText}`);
            continue;
        }

        stubs.push(`${keyword} ${name} = ...`);
    }

    return stubs;
}

function parseGoImport(node: Node): GoImport | null {
    const pathNode = node.childForFieldName('path');
    if (pathNode === null) {
        return null;
    }

    const nameNode = node.childForFieldName('name');
    return {
        importPath: stripGoStringLiteral(pathNode.text),
        alias: nameNode !== null && nameNode.type === 'package_identifier' ? nameNode.text : null,
        isBlank: nameNode?.type === 'blank_identifier',
        isDot: nameNode?.type === 'dot',
    };
}

function collectImportSpecs(node: Node): Node[] {
    const specs: Node[] = [];
    for (const child of node.namedChildren) {
        if (child.type === 'import_spec') {
            specs.push(child);
            continue;
        }

        if (child.type === 'import_spec_list') {
            specs.push(...getNamedChildrenByType(child, 'import_spec'));
        }
    }

    return specs;
}

export async function extractGoImports(source: string, abort?: AbortSignal): Promise<GoImport[]> {
    const result = await parseGoFile(source, abort);
    return result.imports;
}

async function parseGoFile(source: string, abort?: AbortSignal): Promise<{ imports: GoImport[]; symbols: string[] }> {
    const tree = await parseGo(source, abort);

    try {
        const imports: GoImport[] = [];
        const symbols: string[] = [];

        for (const child of tree.rootNode.namedChildren) {
            if (child.type === 'import_declaration') {
                for (const importSpec of collectImportSpecs(child)) {
                    const parsedImport = parseGoImport(importSpec);
                    if (parsedImport !== null) {
                        imports.push(parsedImport);
                    }
                }
                continue;
            }

            if (child.type === 'function_declaration') {
                const stub = formatGoFunctionStub(child);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (child.type === 'method_declaration') {
                const stub = formatGoMethodStub(child);
                if (stub !== null) {
                    symbols.push(stub);
                }
                continue;
            }

            if (child.type === 'type_declaration') {
                for (const typeSpec of child.namedChildren) {
                    if (typeSpec.type !== 'type_alias' && typeSpec.type !== 'type_spec') {
                        continue;
                    }

                    const stub = formatGoTypeStub(typeSpec);
                    if (stub !== null) {
                        symbols.push(stub);
                    }
                }
                continue;
            }

            if (child.type === 'const_declaration') {
                for (const specNode of getNamedChildrenByType(child, 'const_spec')) {
                    symbols.push(...formatGoValueSpec(specNode, 'const'));
                }
                continue;
            }

            if (child.type === 'var_declaration') {
                for (const specNode of getNamedChildrenByType(child, 'var_spec')) {
                    symbols.push(...formatGoValueSpec(specNode, 'var'));
                }
            }
        }

        return { imports, symbols };
    } finally {
        tree.delete();
    }
}

const goFileParser: LanguageFileParser<GoImport> = {
    parse: parseGoFile,
};

fileContextRegistry.registerParser('go', goFileParser);

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function getContainingWorkspaceRoot(filePath: string, workspaceRoots: string[]): string | null {
    let bestMatch: string | null = null;
    for (const workspaceRoot of workspaceRoots) {
        const relativePath = path.relative(workspaceRoot, filePath);
        const isInsideWorkspace = relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
        if (!isInsideWorkspace) {
            continue;
        }

        if (bestMatch === null || workspaceRoot.length > bestMatch.length) {
            bestMatch = workspaceRoot;
        }
    }

    return bestMatch;
}

async function findNearestGoModuleRoot(documentPath: string, workspaceRoots: string[]): Promise<string | null> {
    const containingWorkspaceRoot = getContainingWorkspaceRoot(documentPath, workspaceRoots);
    if (containingWorkspaceRoot === null) {
        return null;
    }

    let currentDirectory = path.dirname(documentPath);
    while (true) {
        const relativePath = path.relative(containingWorkspaceRoot, currentDirectory);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return null;
        }

        if (await pathExists(path.join(currentDirectory, 'go.mod'))) {
            return currentDirectory;
        }

        if (currentDirectory === containingWorkspaceRoot) {
            return null;
        }

        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            return null;
        }
        currentDirectory = parentDirectory;
    }
}

async function readGoModule(goModPath: string): Promise<GoModule | null> {
    try {
        const source = await fs.readFile(goModPath, 'utf8');
        for (const rawLine of source.split(/\r?\n/u)) {
            const line = rawLine.replace(/\/\/.*$/u, '').trim();
            if (!line.startsWith('module ')) {
                continue;
            }

            const modulePath = line.slice('module '.length).trim().replace(/^['"]|['"]$/gu, '');
            if (modulePath.length > 0) {
                return {
                    modulePath,
                    rootPath: path.dirname(goModPath),
                };
            }
        }

        return null;
    } catch {
        return null;
    }
}

async function collectGoModules(documentPath: string, workspaceRoots: string[]): Promise<GoModule[]> {
    const candidateRoots = new Set<string>();
    const nearestModuleRoot = await findNearestGoModuleRoot(documentPath, workspaceRoots);
    if (nearestModuleRoot !== null) {
        candidateRoots.add(nearestModuleRoot);
    }

    for (const workspaceRoot of workspaceRoots) {
        if (await pathExists(path.join(workspaceRoot, 'go.mod'))) {
            candidateRoots.add(workspaceRoot);
        }
    }

    const modules = (await Promise.all(
        [...candidateRoots].map(async (rootPath) => await readGoModule(path.join(rootPath, 'go.mod'))),
    )).filter((goModule): goModule is GoModule => goModule !== null);

    modules.sort((left, right) => right.modulePath.length - left.modulePath.length);
    return modules;
}

function resolveImportPathToDirectory(importPath: string, goModule: GoModule): string | null {
    if (importPath === goModule.modulePath) {
        return goModule.rootPath;
    }

    if (!importPath.startsWith(goModule.modulePath + '/')) {
        return null;
    }

    const packageSuffix = importPath.slice(goModule.modulePath.length + 1);
    return path.join(goModule.rootPath, ...packageSuffix.split('/'));
}

async function listGoPackageFiles(packageDirectory: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(packageDirectory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go'))
            .map((entry) => path.join(packageDirectory, entry.name))
            .sort();
    } catch {
        return [];
    }
}

function getGoPackageImportPath(packageDirectory: string, goModule: GoModule): string | null {
    const relativePath = path.relative(goModule.rootPath, packageDirectory);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    if (relativePath.length === 0) {
        return goModule.modulePath;
    }

    return `${goModule.modulePath}/${relativePath.split(path.sep).join('/')}`;
}

function findContainingGoModule(directoryPath: string, goModules: GoModule[]): GoModule | null {
    for (const goModule of goModules) {
        const relativePath = path.relative(goModule.rootPath, directoryPath);
        if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
            return goModule;
        }
    }

    return null;
}

async function resolveCurrentGoPackageTarget(
    documentPath: string,
    goModules: GoModule[],
): Promise<ImportedContextTarget | null> {
    const packageDirectory = path.dirname(documentPath);
    const goModule = findContainingGoModule(packageDirectory, goModules);
    if (goModule === null) {
        return null;
    }

    const packageImportPath = getGoPackageImportPath(packageDirectory, goModule);
    if (packageImportPath === null) {
        return null;
    }

    const siblingFilePaths = (await listGoPackageFiles(packageDirectory))
        .filter((filePath) => path.normalize(filePath) !== path.normalize(documentPath));
    if (siblingFilePaths.length === 0) {
        return null;
    }

    return {
        displayName: formatGoTargetDisplayName(packageImportPath),
        filePaths: siblingFilePaths,
    };
}

function formatGoTargetDisplayName(importPath: string): string {
    return `${importPath}/*.go`;
}

export async function resolveGoImportTargets(
    documentPath: string,
    workspaceRoots: string[],
    imports: GoImport[],
): Promise<ImportedContextTarget[]> {
    const goModules = await collectGoModules(documentPath, workspaceRoots);
    const targets: ImportedContextTarget[] = [];
    const seenDirectories = new Set<string>();
    const currentPackageTarget = await resolveCurrentGoPackageTarget(documentPath, goModules);
    if (currentPackageTarget !== null) {
        targets.push(currentPackageTarget);
        seenDirectories.add(path.normalize(path.dirname(documentPath)));
    }

    const maxTargets = defaultMaxImportedFiles + (currentPackageTarget === null ? 0 : 1);

    for (const goImport of imports) {
        if (goImport.importPath.length === 0 || goImport.isBlank) {
            continue;
        }

        for (const goModule of goModules) {
            const packageDirectory = resolveImportPathToDirectory(goImport.importPath, goModule);
            if (packageDirectory === null) {
                continue;
            }

            const normalizedDirectory = path.normalize(packageDirectory);
            if (seenDirectories.has(normalizedDirectory)) {
                break;
            }

            const filePaths = await listGoPackageFiles(normalizedDirectory);
            if (filePaths.length === 0) {
                break;
            }

            seenDirectories.add(normalizedDirectory);
            targets.push({
                displayName: formatGoTargetDisplayName(goImport.importPath),
                filePaths,
            });
            break;
        }

        if (targets.length >= maxTargets) {
            break;
        }
    }

    return targets;
}

export function formatGoContextBlock(fileName: string, symbols: string[]): string {
    return `// ${fileName}\n${symbols.join('\n')}`;
}

export function formatGoActiveFileBlock(fileName: string, prefix: string): string {
    return `// ${fileName}\n${prefix}`;
}

export const goPrefixAugmentationProvider: PrefixAugmentationProvider<GoImport> = {
    supports(document: TextDocument): boolean {
        return document.languageId === 'go' && document.uri.scheme === 'file';
    },
    collectImports: extractGoImports,
    resolveImportTargets: resolveGoImportTargets,
    formatContextBlock: formatGoContextBlock,
    formatActiveFileBlock: formatGoActiveFileBlock,
};
