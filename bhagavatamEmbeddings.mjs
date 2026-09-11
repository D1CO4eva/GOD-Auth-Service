import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDINGS_DIR = path.join(__dirname, 'sbm_context_search_cache', 'embeddings');
const VECTORS_PATH = path.join(EMBEDDINGS_DIR, 'verse_embeddings.f32');
const META_PATH = path.join(EMBEDDINGS_DIR, 'verse_embeddings_meta.json');
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

let indexPromise = null;
let extractorPromise = null;

const loadExtractor = async () => {
  if (!extractorPromise) {
    extractorPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.cacheDir = path.join(__dirname, '.transformers-cache');
      return pipeline('feature-extraction', MODEL_NAME, { quantized: true });
    });
  }
  return extractorPromise;
};

const loadIndex = async () => {
  const [metaRaw, vectorsRaw] = await Promise.all([
    fs.readFile(META_PATH, 'utf8'),
    fs.readFile(VECTORS_PATH)
  ]);
  const meta = JSON.parse(metaRaw);
  const vectors = new Float32Array(
    vectorsRaw.buffer,
    vectorsRaw.byteOffset,
    vectorsRaw.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  if (vectors.length !== meta.count * meta.dim) {
    throw new Error(
      `Embedding index size mismatch: expected ${meta.count * meta.dim} floats, got ${vectors.length}`
    );
  }
  return { meta, vectors };
};

// Returns null (never throws) when the embedding index or model isn't available,
// so semantic scoring degrades gracefully to lexical-only search.
export const ensureEmbeddingIndex = async () => {
  if (!indexPromise) {
    indexPromise = loadIndex().catch((error) => {
      console.error('Bhagavatam embedding index unavailable, semantic scoring disabled:', error.message);
      indexPromise = null;
      return null;
    });
  }
  return indexPromise;
};

export const embedQuery = async (text) => {
  const extractor = await loadExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.data; // Float32Array, already L2-normalized
};

// Brute-force cosine similarity (vectors are pre-normalized, so this is a plain dot product).
// 14k x 384 floats is small enough that this runs in low tens of milliseconds per query.
export const semanticSearch = async (queryText, { topK = 40 } = {}) => {
  const normalizedQuery = (queryText || '').trim();
  if (!normalizedQuery) return [];

  const index = await ensureEmbeddingIndex();
  if (!index) return [];

  let queryVector;
  try {
    queryVector = await embedQuery(normalizedQuery);
  } catch (error) {
    console.error('Bhagavatam query embedding failed, semantic scoring skipped:', error.message);
    return [];
  }

  const { meta, vectors } = index;
  const { dim, count, uids } = meta;
  const scored = new Array(count);

  for (let i = 0; i < count; i++) {
    const offset = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) {
      dot += vectors[offset + d] * queryVector[d];
    }
    scored[i] = { uid: uids[i], score: dot };
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
};
