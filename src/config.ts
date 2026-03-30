import { workspace } from 'vscode';
import { isPromptTemplateType, PromptTemplateType } from './prompt_renderer';

export const configurationSection = 'tabRocket';
const defaultBaseUrl = 'http://127.0.0.1:1234/v1';
const defaultModel = 'qwen3-coder-30b';
const defaultPromptTemplate = 'qwen';
const defaultPrefixContextMaxLength = 4000;
const defaultSuffixContextMaxLength = 4000;
const defaultDebounceMs = 250;
const defaultForbiddenFileNames: string[] = ['.env*'];

export interface TabRocketConfig {
    baseUrl: string;
    model: string;
    promptTemplate: PromptTemplateType;
    prefixContextMaxLength: number;
    suffixContextMaxLength: number;
    debounceMs: number;
    forbiddenFileNames: string[];
}

export function getTabRocketConfig(): TabRocketConfig {
    const config = workspace.getConfiguration(configurationSection);
    const promptTemplateSetting = config.get<string>('promptTemplate', defaultPromptTemplate);

    return {
        baseUrl: config.get<string>('baseUrl', defaultBaseUrl),
        model: config.get<string>('model', defaultModel),
        promptTemplate: isPromptTemplateType(promptTemplateSetting) ? promptTemplateSetting : defaultPromptTemplate,
        prefixContextMaxLength: Math.max(0, config.get<number>('prefixContextMaxLength', defaultPrefixContextMaxLength)),
        suffixContextMaxLength: Math.max(0, config.get<number>('suffixContextMaxLength', defaultSuffixContextMaxLength)),
        debounceMs: config.get<number>('debounceMs', defaultDebounceMs),
        forbiddenFileNames: config.get<string[]>('forbiddenFileNames', defaultForbiddenFileNames)
            .map((fileName) => fileName.trim())
            .filter((fileName) => fileName.length > 0),
    };
}
