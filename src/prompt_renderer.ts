export const promptTemplateTypes = [
    'stablecode',
    'qwen',
    'codestral',
    'seedcoder',
] as const;

export type PromptTemplateType = typeof promptTemplateTypes[number];

type PromptTemplateDefinition = {
    reservedTokens: readonly string[];
    render: (prefix: string, suffix: string) => string;
};

const promptTemplateDefinitions: Record<PromptTemplateType, PromptTemplateDefinition> = {
    stablecode: {
        reservedTokens: ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>'],
        render: (prefix, suffix) => '<fim_prefix>' + prefix + '<fim_suffix>' + suffix + '<fim_middle>',
    },
    qwen: {
        reservedTokens: ['<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|end_of_text|>', '<|fim_pad|>', '<|endoftext|>', '<|file_sep|>', '<|file_separator|>'],
        render: (prefix, suffix) => '<|fim_prefix|>' + prefix + '<|fim_suffix|>' + suffix + '<|fim_middle|>',
    },
    codestral: {
        reservedTokens: ['[SUFFIX]', '[PREFIX]'],
        render: (prefix, suffix) => '[SUFFIX]' + suffix + '[PREFIX]' + prefix,
    },
    seedcoder: {
        reservedTokens: ['<[fim-suffix]>', '<[fim-prefix]>', '<[fim-middle]>', '<[end▁of▁sentence]>', '<[begin▁of▁sentence]>'],
        render: (prefix, suffix) => '<[fim-suffix]>' + suffix + '<[fim-prefix]>' + prefix + '<[fim-middle]>',
    },
};

export function isPromptTemplateType(value: string): value is PromptTemplateType {
    return promptTemplateTypes.includes(value as PromptTemplateType);
}

export function getReservedPromptTokens(templateType: PromptTemplateType): readonly string[] {
    return promptTemplateDefinitions[templateType].reservedTokens;
}

function maskReservedPromptToken(token: string): string {
    if (token.length < 2) {
        return token;
    }

    return token[0] + ' ' + token.slice(1);
}

function maskReservedPromptTokens(text: string, reservedTokens: readonly string[]): string {
    let maskedText = text;
    for (const token of reservedTokens) {
        maskedText = maskedText.replaceAll(token, maskReservedPromptToken(token));
    }

    return maskedText;
}

export function renderInfillPrompt(templateType: PromptTemplateType, prefix: string, suffix: string): string {
    const reservedTokens = getReservedPromptTokens(templateType);
    const maskedPrefix = maskReservedPromptTokens(prefix, reservedTokens);
    const maskedSuffix = maskReservedPromptTokens(suffix, reservedTokens);

    return promptTemplateDefinitions[templateType].render(maskedPrefix, maskedSuffix);
}
