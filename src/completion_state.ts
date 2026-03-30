import { Disposable, Event, EventEmitter, Memento } from 'vscode';

const completionsEnabledKey = 'tabRocket.completionsEnabled';
const snoozeUntilKey = 'tabRocket.snoozeUntil';

export class CompletionStateController implements Disposable {
    private readonly changeEmitter = new EventEmitter<void>();
    private enabled: boolean;
    private snoozeUntil: number | null;
    private snoozeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly storage: Memento) {
        this.enabled = this.storage.get<boolean>(completionsEnabledKey, true);
        this.snoozeUntil = this.storage.get<number | null>(snoozeUntilKey, null);

        if (this.snoozeUntil !== null && this.snoozeUntil <= Date.now()) {
            this.snoozeUntil = null;
            void this.storage.update(snoozeUntilKey, null);
        }

        this.scheduleSnoozeTimer();
    }

    public get onDidChangeState(): Event<void> {
        return this.changeEmitter.event;
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public isSnoozed(): boolean {
        return this.snoozeUntil !== null && this.snoozeUntil > Date.now();
    }

    public getSnoozeUntil(): number | null {
        return this.snoozeUntil;
    }

    public shouldProvideCompletions(): boolean {
        return this.enabled && !this.isSnoozed();
    }

    public async enable(): Promise<void> {
        this.enabled = true;
        this.snoozeUntil = null;
        await this.persistState();
    }

    public async disable(): Promise<void> {
        this.enabled = false;
        this.snoozeUntil = null;
        await this.persistState();
    }

    public async snooze(minutes: number): Promise<void> {
        this.enabled = true;
        this.snoozeUntil = Date.now() + (minutes * 60 * 1000);
        await this.persistState();
    }

    private async persistState(): Promise<void> {
        await Promise.all([
            this.storage.update(completionsEnabledKey, this.enabled),
            this.storage.update(snoozeUntilKey, this.snoozeUntil),
        ]);

        this.scheduleSnoozeTimer();
        this.changeEmitter.fire();
    }

    private scheduleSnoozeTimer(): void {
        if (this.snoozeTimer !== null) {
            clearTimeout(this.snoozeTimer);
            this.snoozeTimer = null;
        }

        if (!this.isSnoozed() || this.snoozeUntil === null) {
            return;
        }

        this.snoozeTimer = setTimeout(() => {
            void this.clearExpiredSnooze();
        }, this.snoozeUntil - Date.now());
    }

    private async clearExpiredSnooze(): Promise<void> {
        if (this.snoozeUntil === null || this.snoozeUntil > Date.now()) {
            this.scheduleSnoozeTimer();
            return;
        }

        this.snoozeUntil = null;
        await this.persistState();
    }

    public dispose(): void {
        if (this.snoozeTimer !== null) {
            clearTimeout(this.snoozeTimer);
            this.snoozeTimer = null;
        }

        this.changeEmitter.dispose();
    }
}
