export interface PromptInput {
  name: string;
  placeholder?: string;
}

export interface CopilotPromptMetadata {
  argumentHint?: string;
  agent?: string;
  model?: string;
  tools?: string[];
}

export interface PortablePrompt {
  rootPath: string;
  sourcePath: string;
  sourceRealPath: string;
  name: string;
  description?: string;
  body: string;
  inputs: PromptInput[];
  metadata: CopilotPromptMetadata;
  contentHash: string;
}

export interface PromptRoot {
  path: string;
  label: string;
}

export interface CatalogPrompt {
  exposedName: string;
  prompt: PortablePrompt;
}

export interface Diagnostic {
  path: string;
  message: string;
}

export interface CatalogSnapshot {
  generation: number;
  signature: string;
  prompts: CatalogPrompt[];
  diagnostics: Diagnostic[];
}
