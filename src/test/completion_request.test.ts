import * as assert from 'assert';
import { formatPythonAugmentedPrefix } from '../completion_request';

suite('completion request', () => {
    test('formats Python augmented prefix with imported context blocks', () => {
        assert.strictEqual(
            formatPythonAugmentedPrefix(
                'pkg/main.py',
                'from .service import fetch_user\n\nfetch_',
                '# pkg/service.py\ndef fetch_user(user_id: str): ...',
            ),
            '# pkg/service.py\ndef fetch_user(user_id: str): ...\n\n# pkg/main.py\nfrom .service import fetch_user\n\nfetch_',
        );
    });

    test('formats Python augmented prefix without imported context', () => {
        assert.strictEqual(
            formatPythonAugmentedPrefix('main.py', 'print(value)', ''),
            '# main.py\nprint(value)',
        );
    });
});
