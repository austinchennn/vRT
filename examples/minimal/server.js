import { defineAgent } from '@vrealtime/core';
import { serve } from '@vrealtime/server/node';
import { model } from './models.js';

serve(defineAgent({
  model: model(process.env.MODEL ?? 'boson'),
  instructions: 'You are a friendly voice assistant. When asked to change colors, call set_accent_color.',
  clientTools: 'accept',
}), { port: 8790, publicDir: new URL('./public', import.meta.url) });
