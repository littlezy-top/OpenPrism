import { runCompile } from '../../compileService.js';

/**
 * compile node — runs LaTeX compilation on the target project
 * and increments the compile attempt counter.
 */
export async function compile(state) {
  const result = await runCompile({
    projectId: state.targetProjectId,
    mainFile: state.targetMainFile,
    engine: state.engine,
  });

  const attempt = (state.compileAttempt || 0) + 1;

  return {
    compileResult: result,
    compileAttempt: attempt,
    progressLog: `[compile] Attempt ${attempt}: ${result.ok ? 'SUCCESS' : 'FAILED'} (exit ${result.status}).`,
  };
}
