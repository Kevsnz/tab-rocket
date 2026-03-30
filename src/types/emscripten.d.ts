declare interface EmscriptenModule {
    locateFile?: (fileName: string, scriptDirectory: string) => string;
}
