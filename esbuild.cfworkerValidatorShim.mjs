// Podmiennik modułu `@modelcontextprotocol/sdk/.../validation/ajv-provider.js` na czas builda
// (patrz alias `ajvProviderShimPlugin()` w `esbuild.js`).
//
// SDK statycznie importuje `AjvJsonSchemaValidator` i używa jej jako fallbacku w konstruktorze
// `Client`/`Server` (`options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator()`) - to sprawia,
// że samo podanie `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` przy tworzeniu klienta
// (patrz `modules/tools/ExternalMcpManager.ts::_createClient`) NIE WYSTARCZA, żeby wyciąć `ajv`
// (i jego generator kodu przez `new Function`) z bundla: fallback zostaje żywym, osiągalnym kodem
// z punktu widzenia tree-shakingu esbuild (esbuild nie wie w czasie budowania, że wywołujący
// ZAWSZE poda `jsonSchemaValidator` - to zależy od runtime'owej wartości `options`), więc
// `ajv-provider.js` (a z nim cały pakiet `ajv`) i tak trafia do bundla.
//
// Ten shim eksportuje TĘ SAMĄ nazwę (`AjvJsonSchemaValidator`), więc podmiana modułu jest
// przezroczysta dla SDK (dalej importuje "AjvJsonSchemaValidator" i konstruuje ją bez zmian w
// swoim kodzie) - tyle że implementacja jedzie na `@cfworker/json-schema`
// (`CfWorkerJsonSchemaValidator`), który waliduje JSON Schema bez `new Function`.
//
// Strażnik `assertNoAjvNewFunction()` w `esbuild.js` liczy wystąpienia `new Function` w gotowym
// `dist/main.js` i wywala build, gdyby ten alias kiedyś przestał trafiać (np. SDK przeniesie albo
// przemianuje `validation/ajv-provider.js` przy podbiciu wersji - to wewnętrzna ścieżka pliku, nie
// część publicznego kontraktu `package.json#exports` SDK).
export { CfWorkerJsonSchemaValidator as AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
