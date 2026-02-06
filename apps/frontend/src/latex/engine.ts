export interface CompileOutcome {
  pdf: Uint8Array;
  log: string;
  status: number;
  engine: string;
}
