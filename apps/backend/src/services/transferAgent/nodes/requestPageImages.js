/**
 * requestPageImages node — signals that the frontend
 * needs to render PDF pages and submit screenshots.
 * The graph will interrupt here, waiting for image submission.
 */
export async function requestPageImages(state) {
  return {
    status: 'waiting_images',
    progressLog: '[requestPageImages] Compilation succeeded. Waiting for frontend to submit page screenshots.',
  };
}
