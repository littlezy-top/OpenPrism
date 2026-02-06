import { runCompile, SUPPORTED_ENGINES } from '../services/compileService.js';

export function registerCompileRoutes(fastify) {
  fastify.post('/api/compile', async (req) => {
    const { projectId, mainFile = 'main.tex', engine = 'pdflatex' } = req.body || {};
    if (!projectId) {
      return { ok: false, error: 'Missing projectId.' };
    }
    if (!SUPPORTED_ENGINES.includes(engine)) {
      return { ok: false, error: `Unsupported engine: ${engine}. Supported: ${SUPPORTED_ENGINES.join(', ')}` };
    }
    return runCompile({ projectId, mainFile, engine });
  });
}
