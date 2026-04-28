export { QueryPlanner, resolveSignals, signalLabel, computeCompositeScore } from './planner.js'
export { classifyQuery, type QueryClassification, type QueryType } from './classifier.js'
export { mergeAndRank, minMaxNormalize, dedupKey, normalizeRRF, normalizeGraphPPR, calibrateSemantic, calibrateKeyword } from './merger.js'
export { buildContext } from './assemble.js'
// context assembly is exposed through opts.context on query()
export { IndexedRunner } from './runners/indexed.js'
