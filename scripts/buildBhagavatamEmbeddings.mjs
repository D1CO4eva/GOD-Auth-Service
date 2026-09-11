import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@xenova/transformers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VERSES_PATH = path.join(ROOT, 'sbm_context_search_cache', 'remote_verses.json');
const OUT_DIR = path.join(ROOT, 'sbm_context_search_cache', 'embeddings');
const OUT_VECTORS_PATH = path.join(OUT_DIR, 'verse_embeddings.f32');
const OUT_META_PATH = path.join(OUT_DIR, 'verse_embeddings_meta.json');

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 32;

// Keep model cache inside the repo so it ships with the image / is reusable across rebuilds.
env.cacheDir = path.join(ROOT, '.transformers-cache');

const readVerses = async () => {
  const raw = await fs.readFile(VERSES_PATH, 'utf8');
  const payload = JSON.parse(raw);
  const rows = Array.isArray(payload?.verses) ? payload.verses : [];
  // tuple: [uid, reference, canto, chapter, verse, chapter_title, sanskrit, transliteration, translation, previous_uid, next_uid]
  return rows.map((row) => ({
    uid: row[0],
    reference: row[1],
    canto: row[2],
    chapter: row[3],
    verse: row[4],
    chapter_title: row[5],
    translation: row[8] || ''
  }));
};

const embeddingInputFor = (verse) => {
  const title = (verse.chapter_title || '').trim();
  const translation = (verse.translation || '').trim();
  return title ? `${title}. ${translation}` : translation;
};

async function main() {
  console.log(`Loading verses from ${VERSES_PATH}`);
  let verses = await readVerses();
  const limit = Number.parseInt(process.env.EMBED_LIMIT || '', 10);
  if (Number.isFinite(limit) && limit > 0) verses = verses.slice(0, limit);
  console.log(`Loaded ${verses.length} verses`);

  console.log(`Loading embedding model ${MODEL_NAME} (first run downloads weights)...`);
  const extractor = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });

  await fs.mkdir(OUT_DIR, { recursive: true });

  let dim = null;
  const uids = new Array(verses.length);
  const chunks = [];
  const startedAt = Date.now();

  for (let start = 0; start < verses.length; start += BATCH_SIZE) {
    const batch = verses.slice(start, start + BATCH_SIZE);
    const inputs = batch.map(embeddingInputFor);
    const output = await extractor(inputs, { pooling: 'mean', normalize: true });

    const [batchSize, embDim] = output.dims;
    if (dim === null) dim = embDim;
    if (embDim !== dim) throw new Error(`Unexpected embedding dim ${embDim}, expected ${dim}`);

    const batchData = output.data; // Float32Array, batchSize * dim, row-major
    chunks.push(Buffer.from(batchData.buffer, batchData.byteOffset, batchData.byteLength).slice());

    for (let i = 0; i < batch.length; i++) {
      uids[start + i] = batch[i].uid;
    }

    if (start % (BATCH_SIZE * 20) === 0) {
      const done = Math.min(start + BATCH_SIZE, verses.length);
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(elapsedSec, 0.001);
      const etaSec = (verses.length - done) / Math.max(rate, 0.001);
      console.log(
        `  embedded ${done}/${verses.length} (${rate.toFixed(1)}/s, eta ${Math.round(etaSec)}s)`
      );
    }
  }

  const vectorBuffer = Buffer.concat(chunks);
  await fs.writeFile(OUT_VECTORS_PATH, vectorBuffer);

  const meta = {
    model: MODEL_NAME,
    dim,
    count: verses.length,
    pooling: 'mean',
    normalized: true,
    built_at: new Date().toISOString(),
    uids
  };
  await fs.writeFile(OUT_META_PATH, JSON.stringify(meta));

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(
    `Wrote ${verses.length} x ${dim} float32 vectors to ${OUT_VECTORS_PATH} (${(vectorBuffer.length / 1e6).toFixed(1)} MB)`
  );
  console.log(`Wrote metadata to ${OUT_META_PATH}`);
  console.log(`Total time: ${totalSec.toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
