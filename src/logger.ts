import { hrtime } from 'process';
import { Disposable, OutputChannel } from 'vscode';

let channel: OutputChannel | undefined;
const start = hrtime.bigint();

export function bindChannel(outputChannel: OutputChannel): Disposable {
    channel = outputChannel;
    return new Disposable(() => {
        if (channel === outputChannel) {
            channel = undefined;
        }
    });
}

export function log(message: string) {
    const time = Number((hrtime.bigint() - start) / BigInt(1000000)) / 1000.0;
    channel?.appendLine(time.toString() + ' ' + message);
}
