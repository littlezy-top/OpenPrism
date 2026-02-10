import { Annotation } from '@langchain/langgraph';

const replace = (_, b) => b;
const appendList = (a, b) => [...(a || []), ...(Array.isArray(b) ? b : [b])];

export const TransferState = Annotation.Root({
  // --- Inputs ---
  sourceProjectId: Annotation({ reducer: replace }),
  sourceMainFile: Annotation({ reducer: replace }),
  targetProjectId: Annotation({ reducer: replace }),
  targetMainFile: Annotation({ reducer: replace }),
  engine: Annotation({ reducer: replace, default: () => 'pdflatex' }),
  maxCompileLoops: Annotation({ reducer: replace, default: () => 5 }),
  maxLayoutLoops: Annotation({ reducer: replace, default: () => 3 }),
  layoutCheck: Annotation({ reducer: replace, default: () => false }),
  llmConfig: Annotation({ reducer: replace }),
  jobId: Annotation({ reducer: replace }),

  // --- Source analysis ---
  sourceProjectRoot: Annotation({ reducer: replace }),
  sourceOutline: Annotation({ reducer: replace }),
  sourceFullContent: Annotation({ reducer: replace }),
  sourceAssets: Annotation({ reducer: replace }),

  // --- Target analysis ---
  targetProjectRoot: Annotation({ reducer: replace }),
  targetOutline: Annotation({ reducer: replace }),
  targetPreamble: Annotation({ reducer: replace }),
  targetTemplateContent: Annotation({ reducer: replace }),

  // --- Transfer plan ---
  transferPlan: Annotation({ reducer: replace }),

  // --- Compile loop ---
  compileResult: Annotation({ reducer: replace }),
  compileAttempt: Annotation({ reducer: replace, default: () => 0 }),

  // --- Layout check ---
  pageImages: Annotation({ reducer: replace }),
  layoutCheckResult: Annotation({ reducer: replace }),
  layoutAttempt: Annotation({ reducer: replace, default: () => 0 }),

  // --- MinerU pipeline ---
  transferMode: Annotation({ reducer: replace, default: () => 'legacy' }),
  mineruConfig: Annotation({ reducer: replace }),
  sourcePdfPath: Annotation({ reducer: replace }),
  sourceMarkdown: Annotation({ reducer: replace }),
  sourceImages: Annotation({ reducer: replace }),
  mineruOutputDir: Annotation({ reducer: replace }),

  // --- Final output ---
  finalPdf: Annotation({ reducer: replace }),
  status: Annotation({ reducer: replace, default: () => 'pending' }),
  error: Annotation({ reducer: replace }),
  progressLog: Annotation({ reducer: appendList, default: () => [] }),
});
