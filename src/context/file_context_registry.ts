import { promises as fs } from 'fs';
import type { Stats } from 'fs';
import * as path from 'path';

export interface LanguageFileParser<TImport> {
    parse(source: string, abort?: AbortSignal): Promise<{ imports: TImport[]; symbols: string[] }>;
};

type FileContext = {
    imports: unknown[];
    symbols: string[];
    size: number;
    mtimeMs: number;
};

const defaultLanguageFromExtension = new Map<string, string>([
    ['.go', 'go'],
    ['.py', 'python'],
    ['.ts', 'typescript'],
    ['.tsx', 'typescript'],
    ['.d.ts', 'typescript'],
]);

function inferLanguageFromFilePath(filePath: string): string | null {
    const baseName = path.basename(filePath);
    if (baseName.endsWith('.d.ts')) {
        return defaultLanguageFromExtension.get('.d.ts') ?? null;
    }

    const extension = path.extname(filePath);
    return defaultLanguageFromExtension.get(extension) ?? null;
}

export class FileContextRegistry {
    private parsers = new Map<string, LanguageFileParser<unknown>>();
    private cache = new Map<string, FileContext>();

    registerParser(language: string, parser: LanguageFileParser<unknown>): void {
        this.parsers.set(language, parser);
    }

    async getImports(filePath: string, abort?: AbortSignal): Promise<unknown[]> {
        const context = await this.getFileContext(filePath, abort);
        return context?.imports ?? [];
    }

    async getSymbols(filePath: string, abort?: AbortSignal): Promise<string[]> {
        const context = await this.getFileContext(filePath, abort);
        return context?.symbols ?? [];
    }

    private async getFileContext(filePath: string, abort?: AbortSignal): Promise<FileContext | null> {
        const cached = this.cache.get(filePath);
        if (cached !== undefined) {
            try {
                const stats = await fs.stat(filePath);
                if (stats.isFile() && stats.size === cached.size && stats.mtimeMs === cached.mtimeMs) {
                    return cached;
                }
            } catch {
                this.cache.delete(filePath);
                return null;
            }
        }

        let stats: Stats;
        try {
            stats = await fs.stat(filePath);
        } catch {
            return null;
        }

        if (!stats.isFile()) {
            return null;
        }

        const language = inferLanguageFromFilePath(filePath);
        const parser = language !== null ? this.parsers.get(language) : undefined;
        if (parser === undefined) {
            return null;
        }

        const content = await fs.readFile(filePath, 'utf8');
        const result = await parser.parse(content, abort);
        const context: FileContext = {
            imports: result.imports,
            symbols: result.symbols,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
        };

        this.cache.set(filePath, context);
        return context;
    }
}

export const fileContextRegistry = new FileContextRegistry();
