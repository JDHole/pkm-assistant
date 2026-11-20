/** Nazwa zasobu Gemini i jego krótkie id wskazują ten sam model. */
export function normalizeGeminiModelId(modelId: string): string {
    return modelId.replace(/^models\//, '');
}
