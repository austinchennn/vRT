/** Sentence end: punctuation followed by whitespace, CJK full stops, or a line break. */
const BOUNDARY = /[.!?…]+["'”’)\]]*(?=\s)|[。！？]+["'”’」』)\]]*|\n+/g;

/**
 * Splits streamed LLM text into sentences for TTS, so speech starts after the
 * first sentence instead of the whole answer. Very short sentences are merged
 * with the next one ("Hi." + "How are you?").
 */
export class SentenceBuffer {
  #text = '';
  readonly #minChars: number;

  constructor(minChars = 12) {
    this.#minChars = minChars;
  }

  /** Adds a delta and returns the sentences it completed. */
  push(delta: string): string[] {
    this.#text += delta;
    const out: string[] = [];
    let last = 0;
    BOUNDARY.lastIndex = 0;
    for (let match = BOUNDARY.exec(this.#text); match !== null; match = BOUNDARY.exec(this.#text)) {
      const end = match.index + match[0].length;
      const sentence = this.#text.slice(last, end).trim();
      if (sentence.length < this.#minChars) continue;
      out.push(sentence);
      last = end;
    }
    this.#text = this.#text.slice(last);
    return out;
  }

  /** Returns whatever is left once the stream ends. */
  flush(): string | undefined {
    const rest = this.#text.trim();
    this.#text = '';
    return rest || undefined;
  }
}
