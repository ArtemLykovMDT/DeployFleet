import { GoogleGenAI, Type } from "@google/genai";
import { Unit, UnitStatus, UnitSource } from '../types';

/**
 * Extracts unit numbers using Gemini 3 Flash Vision.
 * Targeted for Fleet Dashboard screenshots where units are 6-digit numbers starting with 62.
 */
type OcrOptions = {
  provider?: 'gemini' | 'openai';
  model?: string;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
};

const OCR_PROMPT = `Analyze this fleet dashboard image.
Identify all unit IDs and their group labels.
Groups must be one of: Pumps, Blender 1, Blender 2, Hydration, C6, Sand 1, Sand 2, Datavan, Unassigned.
Rules:
1. Pump unit IDs are 6-digit numbers starting with '62' (e.g., 621696, 622011) shown in the card headers.
2. Blender/Sand/Datavan may have 5-6 digit IDs shown in their tiles (e.g., Blender 1: 750125, Sand 1: 218316).
2a. Datavan ID may be shown vertically along the left edge of the Datavan tile (e.g., 218316) near the "Datavan" label.
3. Hydration and C6 can be empty; if no unit ID is present there, do not invent one.
4. Ignore other numbers like RPM, flow rate, pressure, timestamps, or measurements.
5. Return ONLY JSON with shape: { "units": [ { "id": string, "group": string } ] }.
6. Include all detected groups, not just Pumps.`;

export const processImage = async (imageFile: File, options?: OcrOptions): Promise<Unit[]> => {
  const provider = options?.provider || 'gemini';
  const requestedModel = options?.model?.trim() || '';

  const base64Data = await fileToBase64(imageFile);
  const base64String = base64Data.split(',')[1];
  const mimeType = base64Data.split(',')[0].match(/:(.*?);/)?.[1] || 'image/png';

  try {
    let jsonText = '';

    if (provider === 'openai') {
      const openAiKey = options?.openAiApiKey || process.env.OPENAI_API_KEY;
      if (!openAiKey) {
        throw new Error('Missing OPENAI_API_KEY in environment variables.');
      }
      const baseUrl = (options?.openAiBaseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const model = requestedModel || process.env.OPENAI_MODEL || 'gpt-4o-mini';

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are an OCR system that outputs only valid JSON.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: OCR_PROMPT },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64String}` } }
              ]
            }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'unit_list',
              schema: {
                type: 'object',
                properties: {
                  units: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        group: { type: 'string' }
                      },
                      required: ['id', 'group']
                    }
                  }
                },
                required: ['units']
              }
            }
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `OpenAI request failed with status ${response.status}`);
      }

      const data = await response.json();
      jsonText = data?.choices?.[0]?.message?.content || '';
    } else {
      const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn("API_KEY missing. OCR cannot run without Gemini credentials.");
        throw new Error("Missing API_KEY or GEMINI_API_KEY in environment variables.");
      }
      const geminiModel = requestedModel || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
      const normalizeModel = (value: string) => value.trim().toLowerCase();
      const isGeminiModel = (value: string) => normalizeModel(value).startsWith('gemini-');
      const fallbackModels = [
        'gemini-3-flash-preview',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
      ];
      const candidateModels = Array.from(new Set([geminiModel, ...fallbackModels])).filter(Boolean);

      if (!isGeminiModel(geminiModel)) {
        throw new Error(`Unsupported model "${geminiModel}". Gemini OCR requires a gemini-* model.`);
      }

      const ai = new GoogleGenAI({ apiKey });
      const requestPayload = {
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64String
              }
            },
            { text: OCR_PROMPT }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                group: { type: Type.STRING }
              },
              required: ["id", "group"]
            }
          }
        }
      } as const;

      let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
      let lastError: unknown = null;

      for (const model of candidateModels) {
        try {
          response = await ai.models.generateContent({
            model,
            ...requestPayload
          });
          break;
        } catch (error) {
          lastError = error;
          const detail = error instanceof Error ? error.message : String(error);
          const isNotFound = /not found|not supported|NOT_FOUND|models\\//i.test(detail);
          if (!isNotFound || model === candidateModels[candidateModels.length - 1]) {
            throw error;
          }
          console.warn(`Model ${model} failed, falling back.`, error);
        }
      }

      if (!response) {
        throw lastError || new Error('Model request failed.');
      }

      jsonText = response.text || '';
    }

    if (!jsonText) return [];

    const parsed = JSON.parse(jsonText);
    const extractedUnits: Array<{ id: string; group: string }> = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.units)
        ? parsed.units
        : [];

    const seen = new Set<string>();
    const uniqueUnits = extractedUnits.filter((unit) => {
      const id = String(unit.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    return uniqueUnits.map((unit) => ({
      id: String(unit.id),
      registrationName: String(unit.id),
      confidence: 99,
      source: UnitSource.OCR,
      status: UnitStatus.PENDING,
      group: unit.group
    }));

  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("AI Vision Extraction Failed", error);
    throw new Error(`Failed to extract units. ${detail}`);
  }
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
};
