import * as assert from 'assert';
import { Position, Range, TextDocument } from 'vscode';
import { createInlineCompletionItem } from '../completion_provider';

suite('completion provider', () => {
    function createDocument(line: string): TextDocument {
        return {
            getText(range?: Range): string {
                if (!range) {
                    return line;
                }

                return line.slice(range.start.character, range.end.character);
            },
            lineAt(): { range: Range } {
                return {
                    range: new Range(new Position(0, 0), new Position(0, line.length)),
                };
            },
        } as unknown as TextDocument;
    }

    test('adds filter text for line replacements that do not start with existing text', () => {
        const document = createDocument('    existingCall()');
        const item = createInlineCompletionItem(
            document,
            {
                completionText: 'return result;',
                startPosition: new Position(0, 0),
                toLineEnd: true,
            } as Parameters<typeof createInlineCompletionItem>[1],
            new Position(0, 0),
        );

        assert.strictEqual(item.insertText, 'return result;');
        assert.strictEqual(item.range?.start.character, 0);
        assert.strictEqual(item.range?.end.character, 18);
        assert.strictEqual(item.filterText, '    existingCall()return result;');
    });

    test('keeps default filtering when typed text is already a prefix of the completion', () => {
        const document = createDocument('ret');
        const item = createInlineCompletionItem(
            document,
            {
                completionText: 'return result;',
                startPosition: new Position(0, 0),
                toLineEnd: false,
            } as Parameters<typeof createInlineCompletionItem>[1],
            new Position(0, 3),
        );

        assert.strictEqual(item.filterText, undefined);
        assert.strictEqual(item.range?.start.character, 0);
        assert.strictEqual(item.range?.end.character, 3);
    });
});
