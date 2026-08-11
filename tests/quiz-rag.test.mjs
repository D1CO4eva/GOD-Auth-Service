import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  coerceQuizRequest,
  createQuizRouter,
  loadQuizKnowledgeBase,
  questionSimilarity,
  retrieveQuizContext,
  selectQuizCandidates,
  validateGroundingAudit,
  validateQuizPayload
} from '../quizRag.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const knowledgeBase = loadQuizKnowledgeBase(
  path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json')
);

const groundingValidationResponse = (openRouterRequest, {
  confidence = 0.97,
  answerSupported = true,
  citationSupported = true,
  unambiguous = true,
  reason = 'The cited source directly supports the question and answer.'
} = {}) => {
  const systemMessage = openRouterRequest.messages.find((message) => message.role === 'system')?.content || '';
  if (!systemMessage.includes('strict, independent grounding evaluator')) return null;
  const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
  const quizMatch = userMessage.match(/QUIZ TO VALIDATE:\s*([\s\S]*?)\n\nCITED SOURCE CONTEXT:/);
  assert.ok(quizMatch, 'grounding validator prompt should contain the submitted quiz');
  const quiz = JSON.parse(quizMatch[1]);
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          questions: quiz.questions.map((question, index) => ({
            question_id: question.id || `q${index + 1}`,
            answer_supported: answerSupported,
            citation_supported: citationSupported,
            unambiguous,
            confidence,
            reason
          }))
        })
      }
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const isSingleQuestionRequest = (openRouterRequest) => {
  const systemMessage = openRouterRequest.messages.find((message) => message.role === 'system')?.content || '';
  return systemMessage.includes('Return a single JSON object with one "question" field');
};

const sourceGroups = [
  { id: 'week-1', label: 'Week 1', source_ids: knowledgeBase.sources.filter((source) => /Week 1|07-05/i.test(source.source_file)).map((source) => source.id) },
  { id: 'week-2', label: 'Week 2', source_ids: knowledgeBase.sources.filter((source) => /SBCC E 2|07-12/i.test(source.source_file)).map((source) => source.id) },
  { id: 'week-3', label: 'Week 3', source_ids: knowledgeBase.sources.filter((source) => /Week 3|07-19/i.test(source.source_file)).map((source) => source.id) },
  { id: 'week-4', label: 'Week 4', source_ids: knowledgeBase.sources.filter((source) => /Week 4|07-26/i.test(source.source_file)).map((source) => source.id) }
];

test('loads the complete converted knowledge base', () => {
  assert.equal(knowledgeBase.statistics.documents, 13);
  assert.ok(knowledgeBase.statistics.chunks >= 25);
  assert.equal(knowledgeBase.sources.length, 13);
  assert.ok(knowledgeBase.sources.every((source) => source.source_sha256.length === 64));
});

test('coerces a frontend quiz request and aliases', () => {
  const request = coerceQuizRequest({
    topic: 'Atmadeva and Dhundhukari',
    number_of_questions: 6,
    question_types: ['multiple choice', 'true-false'],
    difficulty: 'intermediate'
  }, knowledgeBase);
  assert.equal(request.prompt, 'Atmadeva and Dhundhukari');
  assert.equal(request.question_count, 6);
  assert.deepEqual(request.question_types, ['multiple_choice', 'true_false']);
});

test('coerces structured topic, source groups, variation, and prior-question history', () => {
  const selectedGroups = sourceGroups.slice(0, 2);
  const request = coerceQuizRequest({
    prompt: 'Generate a fresh two-week quiz.',
    topic: 'Brahma Sutras',
    coverage_label: 'Week 1 + Week 2',
    variation_id: 'test-variation-1',
    source_groups: selectedGroups,
    avoid_questions: ['Who authored the Brahma Sutras?']
  }, knowledgeBase);
  assert.equal(request.retrieval_query, 'Brahma Sutras');
  assert.equal(request.coverage_label, 'Week 1 + Week 2');
  assert.equal(request.source_groups.length, 2);
  assert.deepEqual(request.source_ids, selectedGroups.flatMap((group) => group.source_ids));
  assert.deepEqual(request.avoid_questions, ['Who authored the Brahma Sutras?']);
  assert.equal(request.require_group_coverage, false, 'specific topics should not force irrelevant groups into questions');
});

test('retrieves grounded context for a specific course topic', () => {
  const request = coerceQuizRequest({
    prompt: 'Atmadeva, Dhundhukari, Gokarna, and the seven-day saptaha',
    question_count: 5
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  assert.ok(chunks.length > 0);
  assert.match(chunks.map((chunk) => chunk.content).join('\n'), /Dhundhukari/i);
  assert.ok(chunks.every((chunk) => typeof chunk.score === 'number'));
});

test('honors an explicit source filter', () => {
  const sourceId = knowledgeBase.sources.find((source) => source.title.includes('Week 1')).id;
  const request = coerceQuizRequest({
    prompt: 'Sanatana Dharma and the Vedas',
    source_ids: [sourceId]
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((chunk) => chunk.source_id === sourceId));
});

test('reserves retrieval capacity for every selected week', () => {
  const request = coerceQuizRequest({
    prompt: 'Generate an all-weeks quiz.',
    coverage_label: 'Week 1 + Week 2 + Week 3 + Week 4',
    source_groups: sourceGroups,
    variation_id: 'balanced-week-test',
    question_count: 5,
    top_k: 8
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const retrievedGroups = new Set(chunks.map((chunk) => chunk.source_group_id));
  assert.equal(chunks.length, 8);
  assert.deepEqual([...retrievedGroups].sort(), sourceGroups.map((group) => group.id).sort());
  assert.ok(sourceGroups.every((group) => chunks.filter((chunk) => chunk.source_group_id === group.id).length >= 1));
});

test('computes confidence from the weakest grounded question and fails unsupported output', () => {
  const quiz = {
    questions: [
      { id: 'q1' },
      { id: 'q2' }
    ]
  };
  const validation = validateGroundingAudit({
    questions: [
      {
        question_id: 'q1',
        answer_supported: true,
        citation_supported: true,
        unambiguous: true,
        confidence: 0.96,
        reason: 'Directly stated.'
      },
      {
        question_id: 'q2',
        answer_supported: false,
        citation_supported: true,
        unambiguous: true,
        confidence: 0.99,
        reason: 'The cited source does not establish the answer.'
      }
    ]
  }, quiz, 0.85);
  assert.equal(validation.passed, false);
  assert.equal(validation.confidence_score, 84, 'a failed criterion must cap confidence below threshold');
  assert.equal(validation.questions[1].answer_supported, false);
});

test('detects semantic question repetition', () => {
  assert.ok(questionSimilarity(
    'What are the four branches of the Vedas?',
    'Which are the four branches of the Vedas?'
  ) >= 0.62);
  assert.ok(questionSimilarity(
    'How does the Atmadeva episode challenge the notion that liberation is only attainable for those with a pure past?',
    'The story of Atmadeva emphasizes that liberation is only attainable for those with a pure past.'
  ) >= 0.62, 'reversed true/false wording should still count as the same assessment concept');
  const request = coerceQuizRequest({
    prompt: 'Create one Vedas question.',
    topic: 'Vedas',
    question_count: 1,
    question_types: ['true_false'],
    avoid_questions: ['What are the four branches of the Vedas?']
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  assert.throws(() => validateQuizPayload({
    title: 'Repeated quiz',
    questions: [{
      type: 'true_false',
      question: 'Which are the four branches of the Vedas?',
      answer: 'True',
      explanation: 'This repeats the earlier assessment angle.',
      source_chunk_ids: [chunks[0].id]
    }]
  }, request, chunks), /repeats or paraphrases/);
});

test('allows distinct questions that necessarily repeat a narrow topic name', () => {
  const request = coerceQuizRequest({
    prompt: 'Create a Mahatmyam quiz.',
    topic: 'Mahatmyam',
    question_count: 2,
    question_types: ['true_false'],
    source_ids: sourceGroups[3].source_ids
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = validateQuizPayload({
    title: 'Mahatmyam distinctions',
    questions: [
      {
        type: 'true_false',
        question: 'Srimad Bhagavatam Mahatmyam describes the benefit of hearing.',
        answer: 'True',
        explanation: 'The cited passage describes benefits associated with hearing.',
        source_chunk_ids: [chunks[0].id]
      },
      {
        type: 'true_false',
        question: 'Srimad Bhagavatam Mahatmyam describes the lineage of transmission.',
        answer: 'True',
        explanation: 'The cited passage describes the transmission lineage.',
        source_chunk_ids: [chunks[0].id]
      }
    ]
  }, request, chunks);
  assert.equal(quiz.questions.length, 2);
});

test('allows a new narrow-topic question that differs from recent history', () => {
  const request = coerceQuizRequest({
    prompt: 'Create another Mahatmyam quiz.',
    topic: 'Mahatmyam',
    question_count: 1,
    question_types: ['true_false'],
    source_ids: sourceGroups[3].source_ids,
    avoid_questions: ['Srimad Bhagavatam Mahatmyam describes the benefit of hearing.']
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = validateQuizPayload({
    title: 'Fresh Mahatmyam angle',
    questions: [{
      type: 'true_false',
      question: 'Srimad Bhagavatam Mahatmyam describes the lineage of transmission.',
      answer: 'True',
      explanation: 'The cited passage describes the transmission lineage.',
      source_chunk_ids: [chunks[0].id]
    }]
  }, request, chunks);
  assert.equal(quiz.questions.length, 1);
});

test('requires question coverage from every selected week for all-topic quizzes', () => {
  const selectedGroups = sourceGroups.slice(0, 2);
  const request = coerceQuizRequest({
    prompt: 'Generate a two-week all-topic quiz.',
    coverage_label: 'Week 1 + Week 2',
    source_groups: selectedGroups,
    question_count: 2,
    question_types: ['true_false'],
    top_k: 4
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const weekOneChunk = chunks.find((chunk) => chunk.source_group_id === 'week-1');
  assert.throws(() => validateQuizPayload({
    title: 'Unbalanced quiz',
    questions: [
      {
        type: 'true_false',
        question: 'Sanatana Dharma is described as eternal.',
        answer: 'True',
        explanation: 'The selected source describes Sanatana as eternal.',
        source_chunk_ids: [weekOneChunk.id]
      },
      {
        type: 'true_false',
        question: 'The Vedas are understood as beginningless revelation.',
        answer: 'True',
        explanation: 'The selected source presents the Vedas as beginningless.',
        source_chunk_ids: [weekOneChunk.id]
      }
    ]
  }, request, chunks), /missing source-group coverage.*Week 2/);
});

test('selects a unique, week-balanced quiz from an oversized regeneration candidate pool', () => {
  const selectedGroups = sourceGroups.slice(0, 2);
  const request = coerceQuizRequest({
    prompt: 'Generate a fresh two-week quiz.',
    coverage_label: 'Week 1 + Week 2',
    source_groups: selectedGroups,
    question_count: 2,
    question_types: ['true_false'],
    top_k: 4,
    avoid_questions: ['Sanatana means eternal in the selected notes.']
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const weekOneChunk = chunks.find((chunk) => chunk.source_group_id === 'week-1');
  const weekTwoChunk = chunks.find((chunk) => chunk.source_group_id === 'week-2');
  const quiz = selectQuizCandidates({
    title: 'Candidate selection',
    questions: [
      {
        type: 'true_false',
        question: 'The selected notes define Sanatana as eternal.',
        answer: 'True',
        explanation: 'This repeats the earlier Sanatana question.',
        source_chunk_ids: [weekOneChunk.id]
      },
      {
        type: 'true_false',
        question: 'Dharma is described as a sustaining principle.',
        answer: 'True',
        explanation: 'The selected Week 1 passage describes Dharma as sustaining.',
        source_chunk_ids: [weekOneChunk.id]
      },
      {
        type: 'true_false',
        question: 'The selected Week 2 material discusses the Brahma Sutras.',
        answer: 'True',
        explanation: 'The selected Week 2 source discusses the Brahma Sutras.',
        source_chunk_ids: [weekTwoChunk.id]
      }
    ]
  }, request, chunks);
  assert.equal(quiz.questions.length, 2);
  assert.deepEqual(quiz.questions.map((question) => question.question), [
    'Dharma is described as a sustaining principle.',
    'The selected Week 2 material discusses the Brahma Sutras.'
  ]);
});

test('uses a semantic history fallback only when a narrow topic lacks enough new concepts', () => {
  const request = coerceQuizRequest({
    prompt: 'Generate another Mahatmyam quiz.',
    topic: 'Mahatmyam',
    question_count: 2,
    question_types: ['true_false'],
    source_ids: sourceGroups[3].source_ids,
    avoid_questions: ['Srimad Bhagavatam Mahatmyam describes the benefit of hearing.']
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = selectQuizCandidates({
    title: 'Narrow-topic candidate selection',
    questions: [
      {
        type: 'true_false',
        question: 'The hearing benefit is described in the Srimad Bhagavatam Mahatmyam.',
        answer: 'True',
        explanation: 'The cited passage describes the benefit of hearing.',
        source_chunk_ids: [chunks[0].id]
      },
      {
        type: 'true_false',
        question: 'Srimad Bhagavatam Mahatmyam describes the lineage of transmission.',
        answer: 'True',
        explanation: 'The cited passage describes the transmission lineage.',
        source_chunk_ids: [chunks[0].id]
      }
    ]
  }, request, chunks);
  assert.deepEqual(quiz.questions.map((question) => question.question), [
    'Srimad Bhagavatam Mahatmyam describes the lineage of transmission.',
    'The hearing benefit is described in the Srimad Bhagavatam Mahatmyam.'
  ]);
});

test('selects valid grounded candidates for an advanced quiz', () => {
  const request = coerceQuizRequest({
    prompt: 'Create an advanced Atmadeva quiz.',
    topic: 'Atmadeva',
    difficulty: 'advanced',
    question_count: 2,
    question_types: ['true_false'],
    source_ids: sourceGroups[2].source_ids
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = selectQuizCandidates({
    title: 'Advanced candidate selection',
    questions: [
      {
        type: 'true_false',
        question: 'Atmadeva sought guidance about his family circumstances.',
        answer: 'True',
        explanation: 'The selected passage describes Atmadeva seeking guidance.',
        source_chunk_ids: [chunks[0].id]
      },
      {
        type: 'true_false',
        question: 'Dhundhukari experienced consequences from his actions.',
        answer: 'True',
        explanation: 'The selected passage describes those consequences.',
        source_chunk_ids: [chunks[1].id]
      },
      {
        type: 'true_false',
        question: 'The episode connects Gokarna’s recitation with Dhundhukari’s liberation.',
        answer: 'True',
        explanation: 'The two cited passages connect the recitation and its result.',
        source_chunk_ids: [chunks[0].id, chunks[1].id]
      }
    ]
  }, request, chunks);
  assert.equal(quiz.questions.length, 2);
  assert.ok(quiz.questions.every((question) => question.source_chunk_ids.length >= 1));
});

test('does not block an advanced quiz solely for using single-chunk citations', () => {
  const request = coerceQuizRequest({
    prompt: 'Create one advanced Atmadeva question.',
    topic: 'Atmadeva',
    difficulty: 'advanced',
    question_count: 1,
    question_types: ['true_false'],
    source_ids: sourceGroups[2].source_ids
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = validateQuizPayload({
    title: 'Shallow advanced quiz',
    questions: [{
      type: 'true_false',
      question: 'Dhundhukari appears in the Atmadeva episode.',
      answer: 'True',
      explanation: 'This is only a one-step recall statement.',
      source_chunk_ids: [chunks[0].id]
    }]
  }, request, chunks);
  assert.equal(quiz.questions.length, 1);
});

test('validates questions and source citations', () => {
  const request = coerceQuizRequest({
    prompt: 'Sanatana Dharma',
    question_count: 1,
    question_types: ['multiple_choice']
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = validateQuizPayload({
    title: 'Sanatana Dharma',
    description: 'A grounded quiz.',
    questions: [{
      type: 'multiple_choice',
      question: 'What does Sanatana mean in the supplied notes?',
      choices: ['Eternal', 'Temporary', 'Material', 'Regional'],
      answer: 'A',
      explanation: 'The notes define Sanatana as eternal or ever-present.',
      source_chunk_ids: [chunks[0].id]
    }]
  }, request, chunks);
  assert.equal(quiz.questions[0].answer, 'Eternal');
  assert.equal(quiz.questions[0].source_chunk_ids[0], chunks[0].id);

  assert.throws(() => validateQuizPayload({
    title: 'Invalid',
    questions: [{
      type: 'multiple_choice',
      question: 'Unsupported citation?',
      choices: ['A', 'B', 'C', 'D'],
      answer: 'A',
      explanation: 'No valid citation.',
      source_chunk_ids: ['not-a-real-chunk']
    }]
  }, request, chunks), /source_chunk_ids/);
});

test('returns a grounded quiz through the iterative single-question fast path', async (context) => {
  const weekOneSourceId = sourceGroups[0].source_ids[0];
  let modelCalls = 0;
  let firstGenerationPrompt = '';
  let firstProviderRouting;
  const fetchImpl = async (_url, options) => {
    const openRouterRequest = JSON.parse(options.body);
    const validationResponse = groundingValidationResponse(openRouterRequest);
    if (validationResponse) return validationResponse;
    modelCalls += 1;
    if (modelCalls === 1) firstProviderRouting = openRouterRequest.provider;
    const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
    if (modelCalls === 1) firstGenerationPrompt = userMessage;
    const chunkId = userMessage.match(/SOURCE_CHUNK_ID:\s*([^\s]+)/)?.[1];
    const answer = 'Eternal';
    const question = {
      type: 'multiple_choice',
      question: 'In the supplied course notes, what does Sanatana mean?',
      choices: ['Eternal', 'Temporary', 'Regional', 'Material'],
      answer,
      explanation: 'The cited notes define Sanatana as eternal.',
      source_chunk_ids: [chunkId]
    };
    const content = isSingleQuestionRequest(openRouterRequest)
      ? { question }
      : { title: 'Reviewed Sanatana Quiz', description: 'A grounded quiz.', questions: [question] };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create a Sanatana Dharma quiz.',
      topic: 'Sanatana Dharma',
      question_count: 1,
      question_types: ['multiple_choice'],
      source_ids: [weekOneSourceId],
      variation_id: 'review-test'
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(modelCalls, 1, 'a valid quiz should require only one model call');
  assert.equal(payload.quiz.questions[0].answer, 'Eternal');
  assert.match(firstGenerationPrompt, /"type":"multiple_choice"/);
  assert.doesNotMatch(firstGenerationPrompt, /For short_answer|multiple_choice \| true_false \| short_answer/);
  assert.deepEqual(firstProviderRouting, { sort: 'throughput', allow_fallbacks: true });
  assert.equal(payload.verification.deterministic_validation_passed, true);
  assert.equal(payload.verification.grounding_confidence_validation_passed, true);
  assert.equal(payload.verification.grounding_confidence_score, 97);
  assert.equal(payload.verification.grounded_editor_passed, false);
  assert.equal(payload.verification.model_calls, 2);
});

test('POST /sb-validate returns an independent confidence score for a submitted quiz', async (context) => {
  const sourceId = sourceGroups[0].source_ids[0];
  const request = coerceQuizRequest({
    prompt: 'Validate a Sanatana Dharma flashcard.',
    topic: 'Sanatana Dharma',
    question_count: 1,
    question_types: ['multiple_choice'],
    source_ids: [sourceId]
  }, knowledgeBase);
  const chunks = retrieveQuizContext(knowledgeBase, request);
  const quiz = {
    title: 'Submitted quiz',
    questions: [{
      type: 'multiple_choice',
      question: 'In the selected notes, what does Sanatana mean?',
      choices: ['Eternal', 'Temporary', 'Regional', 'Material'],
      answer: 'Eternal',
      explanation: 'The cited notes define Sanatana as eternal.',
      source_chunk_ids: [chunks[0].id]
    }]
  };
  const fetchImpl = async (_url, options) => {
    const response = groundingValidationResponse(JSON.parse(options.body));
    assert.ok(response, '/sb-validate should make a grounding-evaluator model call');
    return response;
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/sb-validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, quiz })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.validation.passed, true);
  assert.equal(payload.validation.confidence_score, 97);
  assert.equal(payload.validation.threshold_score, 95);
  assert.equal(payload.validation.endpoint, '/sb-validate');
  assert.equal(payload.quiz, undefined, 'the validation endpoint returns the evaluation, not the submitted content');
});

test('generation rejects a 94% draft, regenerates it, and returns only the 95%+ result', async (context) => {
  const sourceId = sourceGroups[0].source_ids[0];
  let generationCalls = 0;
  let validationCalls = 0;
  const fetchImpl = async (_url, options) => {
    const openRouterRequest = JSON.parse(options.body);
    const validationResponse = groundingValidationResponse(openRouterRequest, {
      confidence: validationCalls === 0 ? 0.94 : 0.97,
      reason: validationCalls === 0
        ? 'The draft needs stronger direct support.'
        : 'The regenerated question and answer are directly supported.'
    });
    if (validationResponse) {
      validationCalls += 1;
      return validationResponse;
    }
    generationCalls += 1;
    const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
    const chunkId = userMessage.match(/SOURCE_CHUNK_ID:\s*([^\s]+)/)?.[1];
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: 'Regenerated grounded quiz',
            questions: [{
              type: 'multiple_choice',
              question: generationCalls === 1
                ? 'What does the first draft claim?'
                : 'In the supplied notes, what does Sanatana mean?',
              choices: ['Eternal', 'Temporary', 'Regional', 'Material'],
              answer: 'Eternal',
              explanation: 'The cited notes define Sanatana as eternal.',
              source_chunk_ids: [chunkId]
            }]
          })
        }
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create one grounded course flashcard.',
      question_count: 1,
      question_types: ['multiple_choice'],
      source_ids: [sourceId]
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(generationCalls, 2, 'a sub-95 draft must be regenerated');
  assert.equal(validationCalls, 2, 'both the draft and regenerated output must be validated');
  assert.equal(payload.verification.grounded_editor_passed, true);
  assert.equal(payload.validation.confidence_score, 97);
  assert.equal(payload.validation.threshold_score, 95);
  assert.match(payload.quiz.questions[0].question, /what does Sanatana mean/i);
});

test('generation withholds a quiz that fails confidence validation after repair', async (context) => {
  const sourceId = sourceGroups[0].source_ids[0];
  let validationCalls = 0;
  const fetchImpl = async (_url, options) => {
    const openRouterRequest = JSON.parse(options.body);
    const validationResponse = groundingValidationResponse(openRouterRequest, {
      confidence: 0.42,
      answerSupported: false,
      reason: 'The cited source does not support the supplied answer.'
    });
    if (validationResponse) {
      validationCalls += 1;
      return validationResponse;
    }
    const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
    const chunkId = userMessage.match(/SOURCE_CHUNK_ID:\s*([^\s]+)/)?.[1];
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: 'Unsupported draft',
            questions: [{
              type: 'multiple_choice',
              question: 'What unsupported conclusion should be accepted?',
              choices: ['A', 'B', 'C', 'D'],
              answer: 'A',
              explanation: 'This claim is not established by the citation.',
              source_chunk_ids: [chunkId]
            }]
          })
        }
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create one course flashcard.',
      question_count: 1,
      question_types: ['multiple_choice'],
      source_ids: [sourceId]
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 422, JSON.stringify(payload));
  assert.equal(payload.code, 'grounding_validation_failed');
  assert.equal(payload.quiz, undefined, 'an ungrounded draft must never reach the frontend');
  assert.equal(payload.validation.confidence_score, 42);
  assert.equal(payload.validation.threshold_score, 95);
  assert.equal(validationCalls, 2, 'the draft and its one repair should both be independently validated');
});

test('uses a validated fallback model when the primary model stalls', async (context) => {
  const sourceId = sourceGroups[0].source_ids[0];
  let primaryAborted = false;
  const fetchImpl = async (_url, options) => {
    const openRouterRequest = JSON.parse(options.body);
    if (openRouterRequest.model === 'slow-primary') {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          primaryAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    }
    const validationResponse = groundingValidationResponse(openRouterRequest);
    if (validationResponse) return validationResponse;
    const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
    const chunkId = userMessage.match(/SOURCE_CHUNK_ID:\s*([^\s]+)/)?.[1];
    const question = {
      type: 'true_false',
      question: 'The selected notes describe Sanatana as eternal.',
      choices: ['True', 'False'],
      answer: 'True',
      explanation: 'The cited notes describe Sanatana as eternal.',
      source_chunk_ids: [chunkId]
    };
    const content = isSingleQuestionRequest(openRouterRequest)
      ? { question }
      : { title: 'Fallback quiz', questions: [question] };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'slow-primary',
    getValidationModel: () => 'fast-fallback',
    getFallbackModels: () => ['fast-fallback'],
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create a one-question quiz.',
      question_count: 1,
      question_types: ['true_false'],
      source_ids: [sourceId]
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.model, 'fast-fallback');
  assert.equal(payload.verification.model_calls, 3);
  assert.equal(primaryAborted, true, 'the stalled primary request should be cancelled after fallback success');
});

test('repairs a draft when it drops required week coverage', async (context) => {
  let modelCalls = 0;
  const fetchImpl = async (_url, options) => {
    const openRouterRequest = JSON.parse(options.body);
    const validationResponse = groundingValidationResponse(openRouterRequest);
    if (validationResponse) return validationResponse;
    modelCalls += 1;
    const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
    const groupChunks = Object.fromEntries(
      [...userMessage.matchAll(/SOURCE_CHUNK_ID:\s*([^\s]+)\nSOURCE_GROUP:\s*(Week [12])/g)]
        .map((match) => [match[2], match[1]])
    );
    const weekOneChunk = groupChunks['Week 1'];
    const weekTwoChunk = groupChunks['Week 2'];
    if (isSingleQuestionRequest(openRouterRequest)) {
      // Simulate a model that ignores its assigned source group and always cites
      // Week 2, so every independent iterative slot drops Week 1 coverage and the
      // pipeline needs exactly one whole-quiz repair pass to fix it.
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              question: {
                type: 'true_false',
                question: 'Sanatana is described in the selected notes as eternal.',
                choices: ['True', 'False'],
                answer: 'True',
                explanation: 'The selected notes define Sanatana as eternal.',
                source_chunk_ids: [weekTwoChunk]
              }
            })
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const quiz = {
      title: 'Two-week coverage quiz',
      description: 'A grounded two-week quiz.',
      questions: [
        {
          type: 'true_false',
          question: 'Sanatana is described in the selected notes as eternal.',
          choices: ['True', 'False'],
          answer: 'True',
          explanation: 'The selected notes define Sanatana as eternal.',
          source_chunk_ids: [weekOneChunk]
        },
        {
          type: 'true_false',
          question: 'The selected Week 2 material discusses the Brahma Sutras.',
          choices: ['True', 'False'],
          answer: 'True',
          explanation: 'The selected Week 2 source discusses the Brahma Sutras.',
          source_chunk_ids: [weekTwoChunk]
        }
      ]
    };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(quiz) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create a quiz covering both selected weeks.',
      coverage_label: 'Week 1 + Week 2',
      question_count: 2,
      question_types: ['true_false'],
      source_groups: sourceGroups.slice(0, 2),
      top_k: 4,
      variation_id: 'editor-coverage-retry-test'
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(modelCalls, 3, 'two non-compliant iterative slots should need exactly one whole-quiz repair');
  assert.equal(payload.quiz.questions[0].sources[0].source_group_label, 'Week 1');
  assert.equal(payload.quiz.questions[1].sources[0].source_group_label, 'Week 2');
});

test('repairs a generated draft that repeats question history', async (context) => {
  let modelCalls = 0;
  let firstGenerationPrompt = '';
  let firstMaxTokens = 0;
  const fetchImpl = async (_url, options) => {
    const openRouterRequest = JSON.parse(options.body);
    const validationResponse = groundingValidationResponse(openRouterRequest);
    if (validationResponse) return validationResponse;
    modelCalls += 1;
    const userMessage = openRouterRequest.messages.find((message) => message.role === 'user')?.content || '';
    if (modelCalls === 1) {
      firstGenerationPrompt = userMessage;
      firstMaxTokens = openRouterRequest.max_tokens;
    }
    const chunkId = userMessage.match(/SOURCE_CHUNK_ID:\s*([^\s]+)/)?.[1];
    if (isSingleQuestionRequest(openRouterRequest)) {
      // Every independent iterative slot stubbornly repeats the same known headline
      // question, so all candidates get filtered as history duplicates and the
      // pipeline needs exactly one whole-quiz repair pass.
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              question: {
                type: 'multiple_choice',
                question: 'What does Sanatana mean in the selected notes?',
                choices: ['It sustains', 'It conceals', 'It divides', 'It expires'],
                answer: 'It sustains',
                explanation: 'The cited notes describe the sustaining quality of Dharma.',
                source_chunk_ids: [chunkId]
              }
            })
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const quiz = {
      title: 'Fresh course quiz',
      description: 'A grounded quiz.',
      questions: [{
        type: 'multiple_choice',
        question: 'Which quality do the selected notes associate with Dharma?',
        choices: ['It sustains', 'It conceals', 'It divides', 'It expires'],
        answer: 'It sustains',
        explanation: 'The cited notes describe the sustaining quality of Dharma.',
        source_chunk_ids: [chunkId]
      }]
    };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(quiz) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Create a fresh course quiz.',
      question_count: 1,
      question_types: ['multiple_choice'],
      source_ids: [sourceGroups[0].source_ids[0]],
      avoid_questions: ['What does Sanatana mean in the selected notes?'],
      variation_id: 'draft-history-repair-test'
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(modelCalls, 6, 'five duplicate iterative candidates should need exactly one whole-quiz repair');
  assert.match(firstGenerationPrompt, /CANDIDATE: this is question 1 of 5/);
  assert.equal(firstMaxTokens, 700, 'iterative single-question calls use the per-question token budget');
  assert.equal(payload.quiz.questions[0].question, 'Which quality do the selected notes associate with Dharma?');
  assert.equal(payload.verification.avoided_question_count, 1);
});

test('returns a bounded timeout instead of leaving generation pending', async (context) => {
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const app = express();
  app.use(express.json());
  app.use(createQuizRouter({
    indexPath: path.join(testDirectory, '..', 'quiz_rag', 'data', 'index.json'),
    getApiKey: () => 'test-key',
    getModel: () => 'test-model',
    fetchImpl,
    modelCallTimeoutMs: 10,
    requestBudgetMs: 20
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/quiz/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Create a bounded quiz.', question_count: 1 })
  });
  const payload = await response.json();
  assert.equal(response.status, 504, JSON.stringify(payload));
  assert.equal(payload.code, 'generation_timeout');
  assert.ok(Date.now() - startedAt < 500, 'the timeout response should be prompt');
});
