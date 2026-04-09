import { AnyPrefixAugmentationProvider } from './prefix_augmentation';
import { goPrefixAugmentationProvider } from './go_context';
import { pythonPrefixAugmentationProvider } from './python_context';
import { typescriptPrefixAugmentationProvider } from './typescript_context';

const prefixAugmentationProviders: AnyPrefixAugmentationProvider[] = [
    goPrefixAugmentationProvider,
    pythonPrefixAugmentationProvider,
    typescriptPrefixAugmentationProvider,
];

export function getPrefixAugmentationProviders(): AnyPrefixAugmentationProvider[] {
    return prefixAugmentationProviders;
}
