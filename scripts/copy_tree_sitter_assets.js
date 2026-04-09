const fs = require('fs/promises');
const path = require('path');

const outDirectory = path.join(__dirname, '..', 'out', 'tree-sitter');

async function copyTreeSitterAssets() {
    await fs.mkdir(outDirectory, { recursive: true });
    await Promise.all([
        fs.copyFile(
            require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
            path.join(outDirectory, 'web-tree-sitter.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-go/tree-sitter-go.wasm'),
            path.join(outDirectory, 'tree-sitter-go.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
            path.join(outDirectory, 'tree-sitter-python.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm'),
            path.join(outDirectory, 'tree-sitter-typescript.wasm'),
        ),
        fs.copyFile(
            require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
            path.join(outDirectory, 'tree-sitter-tsx.wasm'),
        ),
    ]);
}

copyTreeSitterAssets().catch((error) => {
    console.error(error);
    process.exit(1);
});
