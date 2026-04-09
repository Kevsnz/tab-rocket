const esbuild = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const outDirectory = path.join(__dirname, 'out');
const treeSitterOutDirectory = path.join(outDirectory, 'tree-sitter');

async function copyTreeSitterAssets() {
    await fs.mkdir(treeSitterOutDirectory, { recursive: true });
    await Promise.all([
        fs.copyFile(
            require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
            path.join(treeSitterOutDirectory, 'web-tree-sitter.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-go/tree-sitter-go.wasm'),
            path.join(treeSitterOutDirectory, 'tree-sitter-go.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
            path.join(treeSitterOutDirectory, 'tree-sitter-python.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
            path.join(treeSitterOutDirectory, 'tree-sitter-typescript.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
            path.join(treeSitterOutDirectory, 'tree-sitter-tsx.wasm'),
        ),
    ]);
}

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/extension.js',
        external: ['vscode'],
        logLevel: 'warning',
        plugins: [
            /* add to the end of plugins array */
            esbuildProblemMatcherPlugin
        ]
    });
    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await copyTreeSitterAssets();
        await ctx.dispose();
    }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd(result => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location === null) { return; }
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            if (result.errors.length === 0) {
                void copyTreeSitterAssets();
            }
            console.log('[watch] build finished');
        });
    }
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
