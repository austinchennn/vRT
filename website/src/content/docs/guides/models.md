---
title: Choose a model
description: Boson, OpenAI, Gemini, or any text model with speech through cascade.
sidebar:
  order: 4
---

Every adapter returns a `RealtimeModel`, so switching models changes one line and no app code.

```js
import { boson } from '@vrealtime/boson';
import { openai } from '@vrealtime/openai';
import { gemini } from '@vrealtime/gemini';

boson({ voice: 'default', turnDetection: 'semantic' }); // BOSON_API_KEY
openai({ voice: 'marin' });                              // OPENAI_API_KEY
gemini({ voice: 'Kore' });                               // GEMINI_API_KEY
```

API keys default to the environment variable shown; pass `apiKey` to set one explicitly.

## Native realtime models

| | Boson Higgs Realtime | OpenAI Realtime | Gemini Live |
|---|---|---|---|
| Package | `@vrealtime/boson` | `@vrealtime/openai` | `@vrealtime/gemini` |
| Turn detection | server or semantic | server or semantic | server |
| Streams tool arguments | yes | yes | no |
| Change tools mid-session | yes | yes | no |
| Truncates to what was heard | natively | natively | by the runtime, locally |
| Input audio without transcoding | PCM 8–48 kHz, G.711 µ-law, Opus | PCM 24 kHz, G.711 µ-law | PCM 8–48 kHz |

Boson and OpenAI share one OpenAI-compatible implementation and differ only in endpoints, authentication and extension events. When the app's audio format is one the model accepts, audio passes through without transcoding.

## Cascade: any text model

`cascade()` combines a speech-to-text model, any text LLM and a text-to-speech model into one realtime model. With `@vrealtime/ai-sdk`, the LLM can be anything the [AI SDK](https://ai-sdk.dev) supports: Claude, OpenAI, or a self-hosted OpenAI-compatible server.

```js
import { createAnthropic } from '@ai-sdk/anthropic';
import { aiSdk } from '@vrealtime/ai-sdk';
import { cascade } from '@vrealtime/cascade';
import { openaiStt, openaiTts } from '@vrealtime/openai';
import { energyVad } from '@vrealtime/vad';

const model = cascade({
  stt: openaiStt(),                                  // speech to text
  llm: aiSdk(createAnthropic()('claude-sonnet-5-5')), // any AI SDK model
  tts: openaiTts(),                                  // text to speech
  vad: energyVad(),                                  // turn detection
});
```

`openaiStt()` and `openaiTts()` work with any OpenAI-compatible speech endpoint through `baseURL`. Without `tts` the agent answers in text only; without `stt` it takes text input only.

## Recognition vocabulary

Bias speech recognition toward names and terms, for example words from the open document, through the session config. It applies on every model that supports it:

```js
serve(agent, {
  configure: (principal, { context }) => ({
    inputTranscription: { language: 'en', vocabulary: context.documentTerms },
  }),
});
```
