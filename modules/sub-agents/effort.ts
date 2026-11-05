import { log } from '../../core/utils/Logger.js';
import type { ReasoningEffort } from '../models/index.js';

export function parseEffort(value: unknown): ReasoningEffort | undefined {
    if (value === 'low' || value === 'medium' || value === 'high') return value;
    if (value !== undefined) log.warn('SubAgent', 'Invalid effort in YAML:', value);
    return undefined;
}
