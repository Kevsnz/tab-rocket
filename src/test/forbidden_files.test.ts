import * as assert from 'assert';
import { getMatchingForbiddenPattern } from '../forbidden_files';

suite('forbidden file matching', () => {
    test('matches exact file name', () => {
        assert.strictEqual(getMatchingForbiddenPattern('.env', ['.env']), '.env');
    });

    test('matches globbed file name variant', () => {
        assert.strictEqual(getMatchingForbiddenPattern('.env.local', ['.env.*']), '.env.*');
    });

    test('matches nested path glob', () => {
        assert.strictEqual(
            getMatchingForbiddenPattern('secrets/prod/server.pem', ['secrets/**/*.pem']),
            'secrets/**/*.pem',
        );
    });

    test('matches windows paths against slash globs', () => {
        assert.strictEqual(
            getMatchingForbiddenPattern('secrets\\prod\\server.pem', ['secrets/**/*.pem']),
            'secrets/**/*.pem',
        );
    });

    test('returns null when no pattern matches', () => {
        assert.strictEqual(getMatchingForbiddenPattern('src/index.ts', ['.env', 'secrets/**/*.pem']), null);
    });
});
