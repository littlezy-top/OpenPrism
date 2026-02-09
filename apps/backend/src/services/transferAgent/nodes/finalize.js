/**
 * finalize node — sets final status and collects results.
 */
export async function finalize(state) {
  const compileOk = state.compileResult?.ok || false;
  const hasPdf = !!state.compileResult?.pdf;

  const finalStatus = compileOk && hasPdf ? 'success' : 'failed';
  const error = !hasPdf
    ? (state.compileResult?.error || 'No PDF generated after all attempts.')
    : undefined;

  return {
    status: finalStatus,
    finalPdf: state.compileResult?.pdf || '',
    error,
    progressLog: `[finalize] Transfer ${finalStatus}. Compile attempts: ${state.compileAttempt}, Layout attempts: ${state.layoutAttempt}.`,
  };
}
