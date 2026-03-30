import micromatch from 'micromatch';
import { basename } from 'path';

export function getMatchingForbiddenPattern(filePath: string, patterns: string[]): string | null {
    const fileName = basename(filePath);
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const pattern of patterns) {
        if (micromatch.isMatch(fileName, pattern) || micromatch.isMatch(normalizedPath, pattern)) {
            return pattern;
        }
    }

    return null;
}
