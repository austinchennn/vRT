// One agent, four models: pick one with MODEL=boson|openai|gemini|cascade.
import { createOpenAI } from '@ai-sdk/openai';
import { aiSdk } from '@vrealtime/ai-sdk';
import { boson } from '@vrealtime/boson';
import { cascade } from '@vrealtime/cascade';
import { gemini } from '@vrealtime/gemini';
import { openai, openaiStt, openaiTts } from '@vrealtime/openai';
import { energyVad } from '@vrealtime/vad';

export function model(name) {
  switch (name) {
    case 'boson': // BOSON_API_KEY
      return boson({ voice: 'default', turnDetection: 'semantic' });
    case 'openai': // OPENAI_API_KEY
      return openai();
    case 'gemini': // GEMINI_API_KEY
      return gemini();
    case 'cascade': // OPENAI_API_KEY: OpenAI STT + any AI SDK model + OpenAI TTS
      return cascade({ stt: openaiStt(), llm: aiSdk(createOpenAI()(process.env.CASCADE_LLM ?? 'gpt-5-mini')), tts: openaiTts(), vad: energyVad() });
    default:
      throw new Error(`Unknown MODEL "${name}": use boson, openai, gemini or cascade`);
  }
}
