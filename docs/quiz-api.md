# Course Quiz RAG API

The quiz API retrieves relevant passages from the converted course-note knowledge base and asks the configured OpenRouter model to generate a source-grounded quiz. The model never receives the entire corpus: the local BM25 index supplies a compact set of relevant chunks, and every returned question cites one or more of those chunks.

## Endpoints

- `GET /api/quiz/health` returns model configuration, source metadata, and index counts without calling the LLM.
- `POST /api/quiz/generate` generates a quiz.
- `POST /api/generate-quiz` and `POST /generate-quiz` are aliases.
- `POST /sb-validate` independently evaluates a submitted quiz against its cited course-note chunks. `POST /api/quiz/sb-validate` is an alias.

## Request

```json
{
  "prompt": "Create a fresh quiz about Sanatana Dharma and the four Vedas",
  "topic": "Vedas",
  "coverage_label": "Week 1 + Week 2",
  "variation_id": "0e962f5a-9ef3-4d3d-bc98-30a8a6da633d",
  "question_count": 10,
  "question_types": ["multiple_choice", "true_false"],
  "difficulty": "mixed",
  "language": "English",
  "include_explanations": true,
  "top_k": 8,
  "source_ids": ["week-1-source-id", "week-2-source-id"],
  "source_groups": [
    { "id": "week-1", "label": "Week 1", "source_ids": ["week-1-source-id"] },
    { "id": "week-2", "label": "Week 2", "source_ids": ["week-2-source-id"] }
  ],
  "avoid_questions": ["What are the four Vedas?"]
}
```

Only `prompt` is required. `query` is accepted as an alias. When `prompt` is absent, `topic` is accepted as the generation prompt. `number_of_questions` and `count` are accepted as aliases for `question_count`.

Limits and allowed values:

- `prompt`: 1-2,000 characters
- `question_count`: 1-35, default 10
- `question_types`: `multiple_choice`, `true_false`, and/or `short_answer`
- `difficulty`: `beginner`, `intermediate`, `advanced`, or `mixed`
- `top_k`: 3-12, default 8
- `source_ids`: optional source IDs returned by the health endpoint
- `topic`: optional structured retrieval and question-focus query; unlike prose in `prompt`, this field is authoritative
- `coverage_label`: optional human-readable selected-week label
- `source_groups`: optional week/source groupings; retrieval reserves capacity for every group, and all-topic quizzes require question coverage from every selected group
- `variation_id`: optional value used to rotate broad all-topic context and request a fresh assessment angle
- `avoid_questions`: up to 60 previous questions. The Quiz Studio sends the 10 most recent questions, and the backend requests four spare candidates so it can prioritize wholly new concepts without a full regeneration. Exact repeats are always discarded. When a narrow topic cannot supply the requested count from new concepts alone, the least-similar non-exact question angles are used as a bounded fallback and reported in `verification.reused_history_concept_count`.

## Response

The response includes the normalized request, model, retrieved source/chunk metadata, and this quiz shape:

```json
{
  "ok": true,
  "quiz": {
    "title": "Sanatana Dharma and the Vedas",
    "description": "A course-note quiz.",
    "questions": [
      {
        "id": "q1",
        "type": "multiple_choice",
        "question": "...",
        "choices": ["...", "...", "...", "..."],
        "answer": "...",
        "explanation": "...",
        "source_chunk_ids": ["week-1-eng-sb-course-...-0001"],
        "sources": [
          {
            "chunk_id": "week-1-eng-sb-course-...-0001",
            "source_id": "week-1-eng-sb-course-...",
            "source_title": "Week 1-ENG-SB Course",
            "source_file": "Week 1-ENG-SB Course.pdf",
            "section": "Document overview"
          }
        ]
      }
    ]
  }
}
```

Successful generation responses also include `validation` and confidence fields under `verification`:

```json
{
  "verification": {
    "grounding_confidence_validation_passed": true,
    "grounding_confidence_score": 94,
    "grounding_confidence_threshold": 95,
    "validation_endpoint": "/sb-validate"
  },
  "validation": {
    "passed": true,
    "confidence_score": 94,
    "average_confidence_score": 97,
    "threshold_score": 95,
    "scoring_method": "minimum_question_confidence",
    "questions": [
      {
        "question_id": "q1",
        "passed": true,
        "confidence_score": 94,
        "answer_supported": true,
        "citation_supported": true,
        "unambiguous": true,
        "reason": "The cited passage directly states the answer."
      }
    ],
    "validator_model": "openai/gpt-4o-mini",
    "endpoint": "/sb-validate"
  }
}
```

The overall confidence score is the lowest question score, not the average, so one unsupported card cannot be hidden by stronger cards. The default pass threshold is 95. A draft below threshold is rejected, regenerated once, and independently revalidated. If the regenerated output still scores below 95, generation returns HTTP 422 with code `grounding_validation_failed` and does not return the quiz.

Set `QUIZ_VALIDATION_MODEL` to route the evaluator independently from generation. `QUIZ_OPENROUTER_FALLBACK_MODELS` applies only to generation; optional validator fallbacks must be configured separately with `QUIZ_VALIDATION_FALLBACK_MODELS`. This prevents the fastest generation fallback from automatically grading its own output.

To validate an existing generation response directly, send its `request` and `quiz` objects to `/sb-validate`:

```json
{
  "request": {
    "prompt": "Create a Vedas flashcard.",
    "question_count": 1,
    "question_types": ["multiple_choice"],
    "source_ids": ["week-5-source-id"]
  },
  "quiz": {
    "title": "Vedas",
    "questions": [
      {
        "type": "multiple_choice",
        "question": "...",
        "choices": ["...", "...", "...", "..."],
        "answer": "...",
        "explanation": "...",
        "source_chunk_ids": ["week-5-source-id-0001"]
      }
    ]
  }
}
```

`/sb-validate` returns only the validation result, not the submitted quiz. It rejects unknown or out-of-scope chunk IDs before calling the evaluator.

The backend also validates question count, type, choices/answer agreement, source-group coverage, citations, and exact/semantic uniqueness within the quiz and against `avoid_questions`. Generation has a 90-second total request budget shared by generation and validation. When `QUIZ_OPENROUTER_FALLBACK_MODELS` is configured, the primary and fallback models run as hedged attempts; slower attempts are cancelled after the first structurally valid result.

Draft generation asks the model for each question independently — one OpenRouter call per question (plus buffer candidates when `avoid_questions` is set), up to `QUESTION_GENERATION_CONCURRENCY` (6) in flight at a time — rather than one large call for the whole quiz. This keeps each call's output small and bounded regardless of `question_count`, so large quizzes (up to 35 questions) don't risk truncated JSON or a single oversized call stalling past the request budget. Within each question slot, the primary and fallback models still race as hedged attempts, matching the rest of the pipeline. The subsequent editor/repair pass and grounding validation still operate on the whole assembled quiz, since those calls stay well within the token and time budget even at the maximum question count.

## Rebuild the knowledge base

Install the ingestion-only Python dependencies in an isolated environment:

```powershell
python -m venv .venv-markitdown
.\.venv-markitdown\Scripts\python.exe -m pip install -r requirements-quiz-ingestion.txt
```

Convert a source directory:

```powershell
$env:OPENROUTER_API_KEY="..."
.\.venv-markitdown\Scripts\python.exe scripts\buildQuizKnowledgeBase.py `
  --input quiz-source-documents `
  --output-dir quiz_rag\data `
  --image-model openai/gpt-4o
```

`--input` may also be a local ZIP file. The builder rejects unsafe ZIP paths, oversized entries, remote inputs, unsupported files, and conversions with too little text. PDFs and Office documents are converted locally. `--image-model` enables MarkItDown's image-LLM conversion for photographed notes; omit it when the sources contain no images.

Generated artifacts:

- `quiz_rag/data/documents/*.md`: one provenance-tagged Markdown document per source
- `quiz_rag/data/manifest.json`: source hashes and corpus statistics
- `quiz_rag/data/index.json`: runtime chunks and inverted search index

The original source files are intentionally excluded from the Cloud Run image. Only converted Markdown and the compact runtime index are deployed.
