import { promises as fs } from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode';
import type { Node } from 'web-tree-sitter';
import {
    deduplicatePaths,
    defaultMaxImportedFiles,
    PrefixAugmentationProvider,
} from './provider_shared';
import { parsePython } from './tree_sitter';

const includedDunderMethods = new Set([
    '__init__',
    '__new__',
    '__call__',
    '__enter__',
    '__exit__',
    '__aenter__',
    '__aexit__',
]);

export type PythonImport = {
    level: number;
    modulePath: string[];
    importedNames: string[][] | null;
};

type ResolvedImportCandidate = {
    path: string;
    level: number;
};

function splitDottedName(text: string): string[] {
    return text
        .split('.')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

function getAliasedImportName(nodeText: string): string {
    const asIndex = nodeText.indexOf(' as ');
    if (asIndex === -1) {
        return nodeText.trim();
    }

    return nodeText.slice(0, asIndex).trim();
}

function getRelativeImport(nodeText: string): { level: number; modulePath: string[] } {
    let level = 0;
    while (level < nodeText.length && nodeText[level] === '.') {
        level += 1;
    }

    return {
        level,
        modulePath: splitDottedName(nodeText.slice(level)),
    };
}

export async function extractPythonImports(source: string, abort?: AbortSignal): Promise<PythonImport[]> {
    const tree = await parsePython(source, abort);

    try {
        const imports: PythonImport[] = [];
        for (const child of tree.rootNode.namedChildren) {
            if (child.type === 'import_statement') {
                for (const nameNode of child.childrenForFieldName('name')) {
                    if (nameNode.type === 'aliased_import') {
                        imports.push({
                            level: 0,
                            modulePath: splitDottedName(getAliasedImportName(nameNode.text)),
                            importedNames: null,
                        });
                        continue;
                    }

                    if (nameNode.type === 'dotted_name') {
                        imports.push({
                            level: 0,
                            modulePath: splitDottedName(nameNode.text),
                            importedNames: null,
                        });
                    }
                }
                continue;
            }

            if (child.type !== 'import_from_statement') {
                continue;
            }

            const moduleNode = child.childForFieldName('module_name');
            if (moduleNode === null) {
                continue;
            }

            const importedNames = child.childrenForFieldName('name')
                .map((nameNode) => splitDottedName(
                    nameNode.type === 'aliased_import' ? getAliasedImportName(nameNode.text) : nameNode.text,
                ))
                .filter((parts) => parts.length > 0);

            if (moduleNode.type === 'relative_import') {
                const relativeImport = getRelativeImport(moduleNode.text);
                imports.push({
                    level: relativeImport.level,
                    modulePath: relativeImport.modulePath,
                    importedNames,
                });
                continue;
            }

            imports.push({
                level: 0,
                modulePath: splitDottedName(moduleNode.text),
                importedNames,
            });
        }

        return imports;
    } finally {
        tree.delete();
    }
}

function isPublicIdentifier(name: string): boolean {
    return !name.startsWith('_');
}

function shouldIncludeMethod(name: string): boolean {
    return isPublicIdentifier(name) || includedDunderMethods.has(name);
}

function isUppercaseConstant(name: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(name);
}

type AssignmentDetails = {
    name: string;
    typeAnnotation: string | null;
};

function formatFunctionStub(nodeText: string, child: Node): string | null {
    const name = child.childForFieldName('name')?.text;
    if (!name || !shouldIncludeMethod(name)) {
        return null;
    }

    const parameters = child.childForFieldName('parameters')?.text ?? '()';
    const returnType = child.childForFieldName('return_type')?.text;
    const asyncPrefix = nodeText.startsWith('async def ') ? 'async ' : '';
    const returnSuffix = returnType ? ` -> ${returnType}` : '';
    return `${asyncPrefix}def ${name}${parameters}${returnSuffix}: ...`;
}

function getDirectAssignmentDetails(node: Node): AssignmentDetails | null {
    const assignmentNode = node.type === 'assignment'
        ? node
        : node.firstNamedChild?.type === 'assignment'
            ? node.firstNamedChild
            : null;

    if (assignmentNode === null) {
        return null;
    }

    const left = assignmentNode.childForFieldName('left');
    if (left?.type !== 'identifier') {
        return null;
    }

    return {
        name: left.text,
        typeAnnotation: assignmentNode.childForFieldName('type')?.text ?? null,
    };
}

function formatAssignmentStub(assignment: AssignmentDetails): string {
    if (assignment.typeAnnotation !== null) {
        return `${assignment.name}: ${assignment.typeAnnotation} = ...`;
    }

    return `${assignment.name} = ...`;
}

function extractPublicClassMembers(classNode: Node): string[] {
    const body = classNode.childForFieldName('body');
    if (body === null) {
        return [];
    }

    const members: string[] = [];
    for (const child of body.namedChildren) {
        const definitionNode = child.type === 'decorated_definition'
            ? child.childForFieldName('definition')
            : child;

        if (definitionNode?.type === 'function_definition') {
            const methodStub = formatFunctionStub(definitionNode.text, definitionNode);
            if (methodStub !== null) {
                members.push(methodStub);
            }
            continue;
        }

        const assignment = getDirectAssignmentDetails(child);
        if (assignment !== null && isPublicIdentifier(assignment.name)) {
            members.push(formatAssignmentStub(assignment));
        }
    }

    return members;
}

function formatClassStub(classNode: Node): string | null {
    const name = classNode.childForFieldName('name')?.text;
    if (!name || !isPublicIdentifier(name)) {
        return null;
    }

    const members = extractPublicClassMembers(classNode);
    if (members.length === 0) {
        return `class ${name}: ...`;
    }

    return `class ${name}:\n${members.map((member) => `    ${member}`).join('\n')}`;
}

export async function extractPythonSymbols(source: string, abort?: AbortSignal): Promise<string[]> {
    const tree = await parsePython(source, abort);

    try {
        const symbols: string[] = [];
        for (const child of tree.rootNode.namedChildren) {
            const definitionNode = child.type === 'decorated_definition'
                ? child.childForFieldName('definition')
                : child;

            if (definitionNode !== null) {
                if (definitionNode.type === 'class_definition') {
                    const classStub = formatClassStub(definitionNode);
                    if (classStub !== null) {
                        symbols.push(classStub);
                        continue;
                    }
                }

                if (definitionNode.type === 'function_definition') {
                    const functionStub = formatFunctionStub(definitionNode.text, definitionNode);
                    if (functionStub !== null) {
                        symbols.push(functionStub);
                        continue;
                    }
                }
            }

            const assignment = getDirectAssignmentDetails(child);
            if (assignment === null || !isUppercaseConstant(assignment.name)) {
                continue;
            }

            symbols.push(formatAssignmentStub(assignment));
        }

        return symbols;
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

async function resolveModuleCandidate(basePath: string, modulePath: string[]): Promise<string | null> {
    if (modulePath.length === 0) {
        return null;
    }

    const moduleFilePath = path.join(basePath, ...modulePath) + '.py';
    if (await pathExists(moduleFilePath)) {
        return moduleFilePath;
    }

    const packageInitPath = path.join(basePath, ...modulePath, '__init__.py');
    if (await pathExists(packageInitPath)) {
        return packageInitPath;
    }

    return null;
}

function getRelativeImportBase(documentPath: string, level: number): string | null {
    let basePath = path.dirname(documentPath);
    for (let index = 1; index < level; index += 1) {
        const parentPath = path.dirname(basePath);
        if (parentPath === basePath) {
            return null;
        }
        basePath = parentPath;
    }

    return basePath;
}

export async function resolvePythonImportPaths(
    documentPath: string,
    workspaceRoots: string[],
    imports: PythonImport[],
): Promise<string[]> {
    const candidates: ResolvedImportCandidate[] = [];

    for (const pythonImport of imports) {
        if (pythonImport.level > 0) {
            const relativeBase = getRelativeImportBase(documentPath, pythonImport.level);
            if (relativeBase === null) {
                continue;
            }

            candidates.push({
                path: path.join(relativeBase, ...pythonImport.modulePath),
                level: pythonImport.level,
            });

            if (pythonImport.modulePath.length === 0) {
                for (const importedName of pythonImport.importedNames ?? []) {
                    candidates.push({
                        path: path.join(relativeBase, ...importedName),
                        level: pythonImport.level,
                    });
                }
            }

            continue;
        }

        for (const workspaceRoot of workspaceRoots) {
            candidates.push({
                path: path.join(workspaceRoot, ...pythonImport.modulePath),
                level: 0,
            });
        }
    }

    const resolvedPaths: string[] = [];
    for (const candidate of candidates) {
        const resolvedPath = await resolveModuleCandidate(path.dirname(candidate.path), [path.basename(candidate.path)]);
        if (resolvedPath !== null) {
            resolvedPaths.push(path.normalize(resolvedPath));
        }

        if (resolvedPaths.length >= defaultMaxImportedFiles) {
            break;
        }
    }

    return deduplicatePaths(resolvedPaths).slice(0, defaultMaxImportedFiles);
}

export function formatPythonContextBlock(fileName: string, symbols: string[]): string {
    return `# ${fileName}\n${symbols.join('\n')}`;
}

export function formatPythonActiveFileBlock(fileName: string, prefix: string): string {
    return `# ${fileName}\n${prefix}`;
}

export const pythonPrefixAugmentationProvider: PrefixAugmentationProvider<PythonImport> = {
    supports(document: TextDocument): boolean {
        return document.languageId === 'python' && document.uri.scheme === 'file';
    },
    collectImports: extractPythonImports,
    resolveImportPaths: resolvePythonImportPaths,
    extractSymbols: extractPythonSymbols,
    formatContextBlock: formatPythonContextBlock,
    formatActiveFileBlock: formatPythonActiveFileBlock,
};
