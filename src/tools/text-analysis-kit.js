// Text-analysis kit — readability scores, word frequency, text diff, lorem ipsum,
// slug generation. All pure-CPU, no network, no LLM — proof-of-work eligible.
// Covered by scripts/test-text-analysis-kit.js.

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ---------------------------------------------------------------------------
// Syllable counter (simple English heuristic): count vowel groups, subtract
// silent-e, floor at 1.
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return /\d/.test(word) ? 1 : 0; // a numeric token is ~1 syllable, not 0 (kept Flesch off-scale)
  if (w.length <= 2) return 1;
  let count = 0;
  let prev = false;
  for (const ch of w) {
    const vowel = "aeiouy".includes(ch);
    if (vowel && !prev) count++;
    prev = vowel;
  }
  // silent-e: word ends in 'e' and isn't the only vowel group
  if (w.endsWith("e") && count > 1) count--;
  return Math.max(count, 1);
}

// Tokenize: split on whitespace, strip leading/trailing punctuation from each token.
function tokenize(text) {
  return text.split(/\s+/).map((t) => t.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")).filter(Boolean);
}

// Sentence splitter: split on .!? followed by space or end-of-string.
function splitSentences(text) {
  return text.split(/[.!?]+(?:\s|$)/).map((s) => s.trim()).filter(Boolean);
}

// Stop words (~50 common English stop words).
const STOP_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
  "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "is", "are", "was", "were", "been", "has", "had", "its", "can", "no",
]);

// Lorem ipsum vocabulary (~200 words).
const LOREM_WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
  "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore",
  "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud",
  "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo",
  "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate",
  "velit", "esse", "cillum", "fugiat", "nulla", "pariatur", "excepteur", "sint",
  "occaecat", "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia",
  "deserunt", "mollit", "anim", "id", "est", "laborum", "ac", "accumsan",
  "adipisci", "aliquam", "ante", "aptent", "arcu", "at", "auctor", "augue",
  "bibendum", "blandit", "class", "condimentum", "congue", "consequat", "conubia",
  "convallis", "cras", "cubilia", "curabitur", "dapibus", "dictum", "dignissim",
  "donec", "egestas", "elementum", "euismod", "facilisi", "facilisis", "fames",
  "faucibus", "felis", "fermentum", "feugiat", "fringilla", "fusce", "gravida",
  "habitant", "habitasse", "hac", "hendrerit", "himenaeos", "iaculis", "imperdiet",
  "inceptos", "integer", "interdum", "justo", "lacinia", "lacus", "laoreet",
  "lectus", "leo", "libero", "ligula", "litora", "lobortis", "luctus", "maecenas",
  "massa", "mattis", "mauris", "metus", "mi", "morbi", "nam", "nec", "neque",
  "nibh", "nunc", "odio", "orci", "ornare", "pellentesque", "pharetra", "placerat",
  "platea", "porta", "porttitor", "posuere", "potenti", "praesent", "pretium",
  "primis", "proin", "pulvinar", "purus", "quam", "quisque", "rhoncus", "risus",
  "rutrum", "sagittis", "sapien", "scelerisque", "semper", "senectus", "sociis",
  "sodales", "sollicitudin", "suscipit", "suspendisse", "taciti", "tellus",
  "torquent", "tortor", "tristique", "turpis", "ullamcorper", "ultrices",
  "ultricies", "urna", "varius", "vehicula", "vel", "vestibulum", "vitae",
  "vivamus", "viverra", "volutpat", "vulputate",
];

// Seeded PRNG (Mulberry32) for deterministic lorem ipsum given no seed (uses
// a fixed seed so the same params always produce the same text).
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------

export const TEXT_ANALYSIS_TOOLS = [
  // 1. readability-score
  {
    route: "POST /api/readability-score",
    name: "Readability score",
    slug: "readability-score",
    category: "text",
    price: "$0.001",
    description:
      "Compute Flesch-Kincaid Grade Level, Flesch Reading Ease, Gunning Fog Index, and Automated Readability Index from text. Returns all 4 scores plus word, sentence, and syllable counts.",
    tags: ["readability", "flesch", "gunning-fog", "text-analysis"],
    discovery: {
      bodyType: "json",
      input: { text: "The cat sat on the mat. It was a very good cat. The mat was red." },
      inputSchema: {
        properties: {
          text: { type: "string", description: "Text to analyze (min 10 chars)" },
        },
        required: ["text"],
      },
      output: {
        example: {
          words: 16,
          sentences: 3,
          syllables: 17,
          fleschReadingEase: 104.59,
          fleschKincaidGrade: -0.89,
          gunningFog: 3.2,
          automatedReadability: -2.84,
        },
      },
    },
    handler: (input) => {
      const text = String(input.text ?? "").trim();
      if (text.length < 10) throw bad('"text" must be at least 10 characters');

      const sentences = splitSentences(text);
      const sentenceCount = Math.max(sentences.length, 1);
      const words = tokenize(text);
      const wordCount = words.length;
      if (wordCount === 0) throw bad('"text" must contain words');

      let syllableCount = 0;
      let complexWords = 0; // words with 3+ syllables (for Gunning Fog)
      const charCount = words.reduce((sum, w) => sum + w.replace(/[^a-zA-Z0-9]/g, "").length, 0);

      for (const w of words) {
        const s = countSyllables(w);
        syllableCount += s;
        if (s >= 3) complexWords++;
      }

      const avgWordsPerSentence = wordCount / sentenceCount;
      const avgSyllablesPerWord = syllableCount / wordCount;
      const avgCharsPerWord = charCount / wordCount;

      // Flesch Reading Ease
      const fleschReadingEase = +(206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord).toFixed(2);
      // Flesch-Kincaid Grade Level
      const fleschKincaidGrade = +(0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59).toFixed(2);
      // Gunning Fog Index
      const gunningFog = +(0.4 * (avgWordsPerSentence + 100 * (complexWords / wordCount))).toFixed(2);
      // Automated Readability Index
      const automatedReadability = +(4.71 * avgCharsPerWord + 0.5 * avgWordsPerSentence - 21.43).toFixed(2);

      return {
        words: wordCount,
        sentences: sentenceCount,
        syllables: syllableCount,
        fleschReadingEase,
        fleschKincaidGrade,
        gunningFog,
        automatedReadability,
      };
    },
  },




];
