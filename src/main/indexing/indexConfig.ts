export const MODEL_DISPLAY_NAME = 'multilingual-e5-small'
export const MODEL_DIMENSIONS = 384
export const MODEL_MAX_TOKENS = 512
export const MODEL_ID = 'e5-small-onnx-fp32:ca456c06b3a9:384:e5-v1'
export const PARSER_VERSION = 1

export function chunkConfigVersion(chunkSize: number, chunkOverlap: number): string {
  return `chunk-v1:${chunkSize}:${chunkOverlap}`
}

export interface CurrentIndexConfig {
  modelId: string
  configVersion: string
}
