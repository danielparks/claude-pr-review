export type DiffSide = "LEFT" | "RIGHT";

export interface ReviewComment {
  path: string;
  body: string;
  side: DiffSide;
  line: number;
  start_line?: number;
  start_side?: DiffSide;
}
