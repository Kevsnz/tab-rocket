import { AnyPrefixAugmentationProvider } from './prefix_augmentation';
import { pythonPrefixAugmentationProvider } from './python_context';
import { typescriptPrefixAugmentationProvider } from './typescript_context';

const prefixAugmentationProviders: AnyPrefixAugmentationProvider[] = [
    pythonPrefixAugmentationProvider,
    typescriptPrefixAugmentationProvider,
];

export function getPrefixAugmentationProviders(): AnyPrefixAugmentationProvider[] {
    return prefixAugmentationProviders;
}
