import { CompletionRequest } from './completion_request';

export class PendingCompletion {
    request: CompletionRequest;
    abortTimer: NodeJS.Timeout;

    constructor(request: CompletionRequest, timeout: () => void, ms: number) {
        this.request = request;
        this.abortTimer = setTimeout(timeout, ms);
    }

    cancelCancellation(): CompletionRequest {
        clearTimeout(this.abortTimer);
        return this.request;
    }
}
