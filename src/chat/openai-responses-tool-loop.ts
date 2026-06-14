import type OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import {
  openAiResponsesParams,
  type OpenAiModelTier,
} from './openai-model-config';

export type OpenAiDialogueTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type OpenAiResponsesToolLoopResult = {
  assistantText: string | null;
  stepsUsed: number;
};

function extractAssistantTextFromResponse(response: Response): string | null {
  const aggregated = String(response.output_text ?? '').trim();
  if (aggregated) return aggregated;

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && part.text?.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  if (!chunks.length) return null;
  return chunks.join('\n\n').trim();
}

function listFunctionCalls(response: Response): ResponseFunctionToolCall[] {
  return (response.output ?? []).filter(
    (item): item is ResponseFunctionToolCall => item.type === 'function_call',
  );
}

/**
 * Loop de autopilot vía Responses API (`/v1/responses`).
 * Compatible con GPT-5.5 + tools + reasoning.effort.
 */
export async function runOpenAiResponsesToolLoop(
  openai: OpenAI,
  options: {
    resolveInstructions: () => Promise<string>;
    dialogue: OpenAiDialogueTurn[];
    tools: FunctionTool[];
    handleToolCall: (
      name: string,
      argsJson: string,
    ) => Promise<Record<string, unknown>>;
    /** Tras procesar todas las tools de un paso (p. ej. parchear salidas multi-vehículo). */
    onToolBatchComplete?: (
      batch: Array<{ name: string; output: string }>,
    ) => void;
    tier?: OpenAiModelTier;
    maxSteps?: number;
    maxOutputTokens?: number;
  },
): Promise<OpenAiResponsesToolLoopResult> {
  const tier = options.tier ?? 'chat';
  const maxSteps = Math.max(1, options.maxSteps ?? 6);
  const maxOutputTokens = options.maxOutputTokens ?? 4096;

  let previousResponseId: string | null = null;
  let pendingToolOutputs: ResponseInputItem.FunctionCallOutput[] | null = null;

  for (let step = 0; step < maxSteps; step++) {
    const instructions = await options.resolveInstructions();

    const response = await openai.responses.create({
      ...openAiResponsesParams({ tier, maxOutputTokens }),
      instructions,
      tools: options.tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: true,
      ...(previousResponseId && pendingToolOutputs
        ? {
            previous_response_id: previousResponseId,
            input: pendingToolOutputs,
          }
        : {
            input: options.dialogue.map((turn) => ({
              role: turn.role,
              content: turn.content,
            })),
          }),
    });

    previousResponseId = response.id;

    if (response.status === 'incomplete') {
      console.warn('[ResponsesToolLoop] respuesta incomplete', {
        step,
        reason: response.incomplete_details?.reason,
      });
    }

    const functionCalls = listFunctionCalls(response);
    if (functionCalls.length > 0) {
      pendingToolOutputs = [];
      const batchMeta: { name: string; output: string }[] = [];
      for (const call of functionCalls) {
        const payload = await options.handleToolCall(
          call.name,
          call.arguments ?? '{}',
        );
        const output = JSON.stringify(payload);
        batchMeta.push({ name: call.name, output });
        pendingToolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        });
      }
      options.onToolBatchComplete?.(batchMeta);
      for (let i = 0; i < batchMeta.length; i++) {
        pendingToolOutputs[i]!.output = batchMeta[i]!.output;
      }
      continue;
    }

    return {
      assistantText: extractAssistantTextFromResponse(response),
      stepsUsed: step + 1,
    };
  }

  return { assistantText: null, stepsUsed: maxSteps };
}
