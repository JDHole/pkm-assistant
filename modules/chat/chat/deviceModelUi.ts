import { t } from '../../../core/i18n/index.js';
import { isLocalPlatform } from '../../models/index.js';
import type { ChatModel, PkmModelSettings, ResolverAgentLike } from '../../models/index.js';

type ModelIdentity = Pick<ChatModel, 'providerId' | 'modelId'>;

/** Input has already passed safeErrorText; append only a static translated hint. */
export function addDeviceModelHint(text: string, settings: PkmModelSettings | undefined,
    agent: ResolverAgentLike, selected?: ModelIdentity | null): string {
    if (settings?.useDeviceModels === true) return text;
    const override = agent?.models?.main || agent?.model;
    if (!override) return text;
    const slash = typeof override === 'string' ? override.indexOf('/') : -1;
    const platform = typeof override === 'string'
        ? (slash > 0 ? override.slice(0, slash) : settings?.chat?.platform)
        : override.platform;
    const model = typeof override === 'string' ? override.slice(slash + 1) : override.model;
    if (!platform || !model) return text;
    const missingKey = !selected && !isLocalPlatform(platform) && !settings?.chat?.apiKeys?.[platform]
        && text.includes('Chat model not configured');
    const connectionFailure = selected?.providerId === platform && selected.modelId === model
        && /failed to fetch|fetch failed|network|ECONNREFUSED|ENOTFOUND|no response|brak połączenia|timeout|timed out/i.test(text);
    return missingKey || connectionFailure ? `${text}\n\n${t('chat.device_model_hint')}` : text;
}

/** Show the resolved instance, never a model name copied from the agent YAML. */
export function renderDeviceModelLabel(container: HTMLElement, model?: ModelIdentity | null): void {
    if (!model?.providerId || !model.modelId) return;
    container.createDiv({ cls: 'pkm-device-model-label',
        text: t('chat.device_model_label', { model: `${model.providerId}/${model.modelId}` }) });
}
