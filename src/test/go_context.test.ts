import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import {
    extractGoImports,
    formatGoContextBlock,
    resolveGoImportTargets,
} from '../context/go_context';
import { fileContextRegistry } from '../context/file_context_registry';

suite('go context', () => {
    test('extracts Go imports from single and grouped import declarations', async () => {
        const imports = await extractGoImports([
            'import local "example.com/project/pkg/local"',
            'import (',
            '    . "example.com/project/pkg/dot"',
            '    _ "net/http/pprof"',
            '    "example.com/project/pkg/plain"',
            ')',
        ].join('\n'));

        assert.deepStrictEqual(imports, [
            {
                importPath: 'example.com/project/pkg/local',
                alias: 'local',
                isBlank: false,
                isDot: false,
            },
            {
                importPath: 'example.com/project/pkg/dot',
                alias: null,
                isBlank: false,
                isDot: true,
            },
            {
                importPath: 'net/http/pprof',
                alias: null,
                isBlank: true,
                isDot: false,
            },
            {
                importPath: 'example.com/project/pkg/plain',
                alias: null,
                isBlank: false,
                isDot: false,
            },
        ]);
    });

    test('extracts exported Go symbols as declaration-like stubs from file', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-go-symbols-'));
        try {
            const filePath = path.join(tempRoot, 'service.go');
            await writeFile(filePath, [
                'package service',
                '',
                'import (',
                '    "context"',
                '    "time"',
                ')',
                '',
                'type User struct {',
                '    ID string',
                '    name string',
                '    CreatedAt time.Time',
                '    *Client',
                '}',
                '',
                'type Reader interface {',
                '    Read(p []byte) (int, error)',
                '    readInternal([]byte) error',
                '}',
                '',
                'type ID = string',
                'type hidden struct{}',
                '',
                'const Version string = "1.0"',
                'const hiddenConst = 1',
                'var DefaultTimeout time.Duration',
                'var hiddenVar = 1',
                '',
                'func NewClient[T any](ctx context.Context, values ...string) (*Client, error) {',
                '    return nil, nil',
                '}',
                '',
                'func helper() {}',
                '',
                'func (c *Client) Fetch(ctx context.Context, id string) (User, error) {',
                '    return User{}, nil',
                '}',
                '',
                'func (c *Client) internal() error {',
                '    return nil',
                '}',
            ].join('\n'), 'utf8');

            const symbols = await fileContextRegistry.getSymbols(filePath);

            assert.deepStrictEqual(symbols, [
                [
                    'type User struct {',
                    '    ID string',
                    '    CreatedAt time.Time',
                    '    *Client',
                    '}',
                ].join('\n'),
                [
                    'type Reader interface {',
                    '    Read(p []byte) (int, error)',
                    '}',
                ].join('\n'),
                'type ID = string',
                'const Version string = ...',
                'var DefaultTimeout time.Duration',
                'func NewClient[T any](ctx context.Context, values ...string) (*Client, error)',
                'func (c *Client) Fetch(ctx context.Context, id string) (User, error)',
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    test('formats Go context blocks with a target header', () => {
        assert.strictEqual(
            formatGoContextBlock('pkg/service/*.go', ['func NewClient() *Client']),
            '// pkg/service/*.go\nfunc NewClient() *Client',
        );
    });

    test('prepends current package symbols before imported Go package targets', async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tab-rocket-go-context-'));
        try {
            await writeFile(path.join(tempRoot, 'go.mod'), 'module example.com/project\n', 'utf8');
            await mkdir(path.join(tempRoot, 'cmd', 'app'), { recursive: true });
            await writeFile(path.join(tempRoot, 'cmd', 'app', 'main.go'), 'package main\n', 'utf8');
            await writeFile(path.join(tempRoot, 'cmd', 'app', 'cli.go'), 'package main\n', 'utf8');
            await writeFile(path.join(tempRoot, 'cmd', 'app', 'run.go'), 'package main\n', 'utf8');
            await writeFile(path.join(tempRoot, 'cmd', 'app', 'main_test.go'), 'package main\n', 'utf8');
            await mkdir(path.join(tempRoot, 'pkg', 'service'), { recursive: true });
            await writeFile(path.join(tempRoot, 'pkg', 'service', 'service.go'), 'package service\n', 'utf8');
            await writeFile(path.join(tempRoot, 'pkg', 'service', 'types.go'), 'package service\n', 'utf8');
            await writeFile(path.join(tempRoot, 'pkg', 'service', 'service_test.go'), 'package service\n', 'utf8');

            const documentPath = path.join(tempRoot, 'cmd', 'app', 'main.go');
            const targets = await resolveGoImportTargets(documentPath, [tempRoot], [
                {
                    importPath: 'example.com/project/pkg/service',
                    alias: null,
                    isBlank: false,
                    isDot: false,
                },
                {
                    importPath: 'fmt',
                    alias: null,
                    isBlank: false,
                    isDot: false,
                },
            ]);

            assert.deepStrictEqual(targets, [
                {
                    displayName: 'example.com/project/cmd/app/*.go',
                    filePaths: [
                        path.join(tempRoot, 'cmd', 'app', 'cli.go'),
                        path.join(tempRoot, 'cmd', 'app', 'run.go'),
                    ],
                },
                {
                    displayName: 'example.com/project/pkg/service/*.go',
                    filePaths: [
                        path.join(tempRoot, 'pkg', 'service', 'service.go'),
                        path.join(tempRoot, 'pkg', 'service', 'types.go'),
                    ],
                },
            ]);
        } finally {
            await rm(tempRoot, { recursive: true, force: true });
        }
    });
});
